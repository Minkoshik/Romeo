import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminError, assertAdminSession } from "./admin-auth";
import { adminCatalogMutationSchema, adminScheduleMutationSchema, type AdminCatalogMutation, type AdminScheduleMutation } from "./admin-catalog-validation";
import { databaseNow, expireMasterHolds, lockAppointmentMaster } from "./appointment-repository";
import { canFitScheduledInterval } from "./availability-engine";
import { getDatabase } from "./db";

type Options = { database?: PrismaClient };
export type AdminMutationResult = { id: string; entityType: string; operation: string };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const order = [{ sortOrder: "asc" }, { id: "asc" }] as const;

function codes(error: unknown) {
  const values = new Set<string>(); const visited = new Set<object>();
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6 || visited.has(value)) return;
    visited.add(value); const row = value as Record<string, unknown>;
    for (const key of ["code", "sqlState", "sqlstate", "originalCode"]) if (typeof row[key] === "string") values.add(row[key]);
    for (const key of ["cause", "meta", "driverAdapterError", "originalError", "error"]) walk(row[key], depth + 1);
  };
  walk(error, 0); return values;
}
function safeError(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  const found = codes(error);
  if (found.has("P2002") || found.has("23505")) return new AdminError("Такой идентификатор или интервал уже существует.", 409);
  if (found.has("P2025")) return new AdminError("Объект не найден.", 404);
  if (found.has("P2003") || found.has("23503")) return new AdminError("Проверьте категорию, услугу и мастера.", 400);
  if (found.has("23P01") || found.has("23514")) return new AdminError("Проверьте значения и пересечения интервалов.", 400);
  return new AdminError("Не удалось сохранить изменения. Повторите попытку позже.", 503);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value);
}
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function fingerprint(value: unknown) { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }

async function transaction<T>(options: Options, run: (tx: Prisma.TransactionClient) => Promise<T>, write = false): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const database = options.database ?? getDatabase();
      return await database.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '12s'`;
        return run(tx);
      }, { isolationLevel: write ? "Serializable" : "RepeatableRead", timeout: 15000, maxWait: 5000 });
    } catch (error) {
      const found = codes(error);
      if (write && attempt < 3 && ["P2034", "40001", "40P01", "P2002", "23505"].some(code => found.has(code))) continue;
      throw safeError(error);
    }
  }
  throw new AdminError("Не удалось сохранить изменения. Повторите попытку позже.", 503);
}

export async function getAdminCatalog(token: string | null, options: Options = {}) {
  return transaction(options, async tx => {
    await assertAdminSession(tx, token);
    const [categories, services, masters, settings] = await Promise.all([
      tx.serviceCategory.findMany({ orderBy: [...order] }),
      tx.service.findMany({ orderBy: [...order], include: { variants: { orderBy: [...order] } } }),
      tx.master.findMany({ orderBy: [...order], include: { services: { orderBy: [{ serviceVariantId: "asc" }, { id: "asc" }] } } }),
      tx.salonSettings.findUniqueOrThrow({ where: { id: "salon" }, select: { currency: true } }),
    ]);
    return {
      currency: settings.currency,
      categories: categories.map(row => ({ id: row.id, slug: row.slug, name: row.name, description: row.description, sortOrder: row.sortOrder, isActive: row.isActive, isDemo: row.isDemo, archivedAt: row.archivedAt?.toISOString() ?? null })),
      services: services.map(row => ({ id: row.id, categoryId: row.categoryId, slug: row.slug, name: row.name, shortDescription: row.shortDescription, detailedDescription: row.detailedDescription, imageUrl: row.imageUrl, sortOrder: row.sortOrder, isActive: row.isActive, isDemo: row.isDemo, isFeatured: row.isFeatured, archivedAt: row.archivedAt?.toISOString() ?? null,
        variants: row.variants.map(variant => ({ id: variant.id, serviceId: variant.serviceId, slug: variant.slug, name: variant.name, priceMinor: variant.priceMinor, durationMinutes: variant.durationMinutes, bufferMinutes: variant.bufferMinutes, sortOrder: variant.sortOrder, isActive: variant.isActive, archivedAt: variant.archivedAt?.toISOString() ?? null })) })),
      masters: masters.map(row => ({ id: row.id, slug: row.slug, name: row.name, specialization: row.specialization, description: row.description, photoUrl: row.photoUrl, sortOrder: row.sortOrder, isBookable: row.isBookable, isDemo: row.isDemo, archivedAt: row.archivedAt?.toISOString() ?? null,
        assignments: row.services.map(assignment => ({ id: assignment.id, masterId: assignment.masterId, serviceVariantId: assignment.serviceVariantId, priceMinorOverride: assignment.priceMinorOverride, durationMinutesOverride: assignment.durationMinutesOverride, bufferMinutesOverride: assignment.bufferMinutesOverride, isActive: assignment.isActive, archivedAt: assignment.archivedAt?.toISOString() ?? null })) })),
    };
  });
}
export type AdminCatalog = Awaited<ReturnType<typeof getAdminCatalog>>;

async function beginMutation(tx: Prisma.TransactionClient, token: string | null, key: string, action: string, input: unknown) {
  const actor = await assertAdminSession(tx, token);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'romeo:admin-mutation:' + key}, 0))`;
  const payloadFingerprint = fingerprint(input);
  const previous = await tx.adminMutation.findUnique({ where: { id: key } });
  if (previous && (previous.actorId !== actor.id || previous.action !== action || previous.payloadFingerprint !== payloadFingerprint)) throw new AdminError("Этот ключ уже использован для другого изменения. Обновите страницу и повторите действие.", 409);
  return { actor, payloadFingerprint, previous };
}
async function finishMutation(tx: Prisma.TransactionClient, input: { idempotencyKey: string; op: string }, actorId: string, payloadFingerprint: string, result: AdminMutationResult, before: unknown, after: unknown) {
  await tx.auditLog.create({ data: { actorId, action: input.op, entityType: result.entityType, entityId: result.id, requestId: input.idempotencyKey,
    changes: json({ before, after }) } });
  await tx.adminMutation.create({ data: { id: input.idempotencyKey, actorId, action: input.op, payloadFingerprint, result: json(result) } });
  return result;
}

async function requireUnarchived(tx: Prisma.TransactionClient, kind: "category" | "service" | "variant" | "master", id: string) {
  const row = kind === "category" ? await tx.serviceCategory.findUnique({ where: { id }, select: { archivedAt: true } })
    : kind === "service" ? await tx.service.findUnique({ where: { id }, select: { archivedAt: true } })
      : kind === "variant" ? await tx.serviceVariant.findUnique({ where: { id }, select: { archivedAt: true } })
        : await tx.master.findUnique({ where: { id }, select: { archivedAt: true } });
  if (!row) throw new AdminError("Объект не найден.", 404);
  if (row.archivedAt) throw new AdminError("Архивный объект нельзя использовать для новых услуг или назначений.", 409);
}
async function assertMasterMayClose(tx: Prisma.TransactionClient, masterId: string, now: Date) {
  const count = await tx.appointment.count({ where: { masterId, occupiedUntil: { gt: now }, OR: [{ status: "CONFIRMED" }, { status: "WAITING_PAYMENT", holdExpiresAt: { gt: now } }] } });
  if (count) throw new AdminError("У мастера есть действующие записи. Сначала перенесите или отмените их.", 409);
}
async function assertWomenSingleVariant(tx: Prisma.TransactionClient, serviceId: string) {
  const service = await tx.service.findUniqueOrThrow({ where: { id: serviceId }, select: { slug: true } });
  if (service.slug === "womens-cut" && await tx.serviceVariant.count({ where: { serviceId, isActive: true, archivedAt: null } }) > 1) throw new AdminError("Женская стрижка должна иметь одну цену без выбора варианта.", 409);
}

async function changeCatalog(tx: Prisma.TransactionClient, input: AdminCatalogMutation, now: Date) {
  // Serializes shared catalogue relations and the one-price women's haircut rule.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('romeo:admin-catalog', 0))`;
  const entityType = input.op.split(".")[0];
  const isDemo = (await tx.salonSettings.findUniqueOrThrow({ where: { id: "salon" }, select: { isDemo: true } })).isDemo;
  let before: unknown = null; let after: { id: string };
  switch (input.op) {
    case "category.create": after = await tx.serviceCategory.create({ data: { isDemo, ...input.data } }); break;
    case "category.update":
      await requireUnarchived(tx, "category", input.id); before = await tx.serviceCategory.findUniqueOrThrow({ where: { id: input.id } });
      after = await tx.serviceCategory.update({ where: { id: input.id }, data: input.data }); break;
    case "category.archive":
      before = await tx.serviceCategory.findUniqueOrThrow({ where: { id: input.id } });
      after = await tx.serviceCategory.update({ where: { id: input.id }, data: { isActive: false, archivedAt: now } }); break;
    case "service.create":
      await requireUnarchived(tx, "category", input.data.categoryId); after = await tx.service.create({ data: { isDemo, ...input.data } }); break;
    case "service.update":
      await requireUnarchived(tx, "service", input.id); if (input.data.categoryId) await requireUnarchived(tx, "category", input.data.categoryId);
      before = await tx.service.findUniqueOrThrow({ where: { id: input.id } }); after = await tx.service.update({ where: { id: input.id }, data: input.data });
      await assertWomenSingleVariant(tx, input.id); break;
    case "service.archive":
      before = await tx.service.findUniqueOrThrow({ where: { id: input.id } }); after = await tx.service.update({ where: { id: input.id }, data: { isActive: false, archivedAt: now } }); break;
    case "variant.create":
      await requireUnarchived(tx, "service", input.data.serviceId); after = await tx.serviceVariant.create({ data: input.data });
      await assertWomenSingleVariant(tx, input.data.serviceId); break;
    case "variant.update":
      await requireUnarchived(tx, "variant", input.id); if (input.data.serviceId) await requireUnarchived(tx, "service", input.data.serviceId);
      before = await tx.serviceVariant.findUniqueOrThrow({ where: { id: input.id } });
      { const row = await tx.serviceVariant.update({ where: { id: input.id }, data: input.data }); after = row; await assertWomenSingleVariant(tx, row.serviceId); } break;
    case "variant.archive":
      before = await tx.serviceVariant.findUniqueOrThrow({ where: { id: input.id } }); after = await tx.serviceVariant.update({ where: { id: input.id }, data: { isActive: false, archivedAt: now } }); break;
    case "master.create": after = await tx.master.create({ data: { isDemo, ...input.data } }); break;
    case "master.update":
      await lockAppointmentMaster(tx, input.id); await expireMasterHolds(tx, input.id); await requireUnarchived(tx, "master", input.id);
      if (input.data.isBookable === false) await assertMasterMayClose(tx, input.id, now);
      before = await tx.master.findUniqueOrThrow({ where: { id: input.id } }); after = await tx.master.update({ where: { id: input.id }, data: input.data }); break;
    case "master.archive":
      await lockAppointmentMaster(tx, input.id); await expireMasterHolds(tx, input.id); await assertMasterMayClose(tx, input.id, now);
      before = await tx.master.findUniqueOrThrow({ where: { id: input.id } }); after = await tx.master.update({ where: { id: input.id }, data: { isBookable: false, archivedAt: now } }); break;
    case "assignment.upsert":
      await lockAppointmentMaster(tx, input.data.masterId); await requireUnarchived(tx, "master", input.data.masterId); await requireUnarchived(tx, "variant", input.data.serviceVariantId);
      { const where = { masterId_serviceVariantId: { masterId: input.data.masterId, serviceVariantId: input.data.serviceVariantId } };
        before = await tx.masterService.findUnique({ where });
        after = await tx.masterService.upsert({ where, create: input.data, update: { ...input.data, archivedAt: null } }); } break;
    case "assignment.archive":
      { const row = await tx.masterService.findUniqueOrThrow({ where: { id: input.id } }); await lockAppointmentMaster(tx, row.masterId);
        before = row; after = await tx.masterService.update({ where: { id: input.id }, data: { isActive: false, archivedAt: now } }); } break;
  }
  return { result: { id: after.id, entityType, operation: input.op }, before, after };
}

export async function mutateAdminCatalog(token: string | null, input: unknown, options: Options = {}): Promise<AdminMutationResult> {
  return transaction(options, async tx => {
    await assertAdminSession(tx, token);
    const parsed = adminCatalogMutationSchema.safeParse(input);
    if (!parsed.success) throw new AdminError("Проверьте поля услуги, категории или мастера.", 400);
    const data = parsed.data;
    const { actor, payloadFingerprint, previous } = await beginMutation(tx, token, data.idempotencyKey, data.op, data);
    if (previous) return previous.result as AdminMutationResult;
    const change = await changeCatalog(tx, data, await databaseNow(tx));
    return finishMutation(tx, data, actor.id, payloadFingerprint, change.result, change.before, change.after);
  }, true);
}

async function readSchedule(tx: Prisma.TransactionClient, masterId: string) {
  const master = await tx.master.findUnique({ where: { id: masterId }, select: { id: true, name: true, isBookable: true, archivedAt: true } });
  if (!master) throw new AdminError("Мастер не найден.", 404);
  const [weekly, exceptions] = await Promise.all([
    tx.weeklySchedule.findMany({ where: { masterId }, select: { id: true, dayOfWeek: true, startMinute: true, endMinute: true }, orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] }),
    tx.scheduleException.findMany({ where: { masterId }, select: { id: true, localDate: true, kind: true, reason: true, intervals: { select: { kind: true, startMinute: true, endMinute: true }, orderBy: [{ kind: "asc" }, { startMinute: "asc" }] } }, orderBy: { localDate: "asc" } }),
  ]);
  return { master: { ...master, archivedAt: master.archivedAt?.toISOString() ?? null }, weekly,
    exceptions: exceptions.map(row => ({ ...row, localDate: row.localDate.toISOString().slice(0, 10) })) };
}
export async function getAdminSchedule(token: string | null, masterId: unknown, options: Options = {}) {
  return transaction(options, async tx => {
    await assertAdminSession(tx, token);
    const id = uuid.safeParse(masterId); if (!id.success) throw new AdminError("Выберите мастера.", 400);
    return readSchedule(tx, id.data);
  });
}
export type AdminSchedule = Awaited<ReturnType<typeof getAdminSchedule>>;

async function assertScheduleKeepsAppointments(tx: Prisma.TransactionClient, masterId: string, now: Date) {
  const [settings, graph, appointments] = await Promise.all([
    tx.salonSettings.findUniqueOrThrow({ where: { id: "salon" }, select: { timezone: true, bookingHorizonDays: true, minimumLeadMinutes: true, slotStepMinutes: true } }),
    readSchedule(tx, masterId),
    tx.appointment.findMany({ where: { masterId, occupiedUntil: { gt: now }, OR: [{ status: "CONFIRMED" }, { status: "WAITING_PAYMENT", holdExpiresAt: { gt: now } }] },
      select: { startsAt: true, occupiedUntil: true, totalDurationMinutes: true, totalBufferMinutes: true } }),
  ]);
  for (const appointment of appointments) {
    const fits = canFitScheduledInterval({ timezone: settings.timezone, policy: settings, durationMinutes: appointment.totalDurationMinutes, bufferMinutes: appointment.totalBufferMinutes,
      weeklyIntervals: graph.weekly, exceptionRows: graph.exceptions.map(row => ({ date: row.localDate, kind: row.kind, intervals: row.intervals })), occupied: [], now }, appointment.startsAt, appointment.occupiedUntil);
    if (!fits) throw new AdminError("Изменение расписания затрагивает действующую запись с учётом технического перерыва. Сначала перенесите или отмените запись.", 409);
  }
}

export async function mutateAdminSchedule(token: string | null, input: unknown, options: Options = {}): Promise<AdminMutationResult> {
  return transaction(options, async tx => {
    await assertAdminSession(tx, token);
    const parsed = adminScheduleMutationSchema.safeParse(input);
    if (!parsed.success) throw new AdminError("Проверьте дату, часы работы и пересечения интервалов. Время должно быть кратно пяти минутам.", 400);
    const data: AdminScheduleMutation = parsed.data;
    const { actor, payloadFingerprint, previous } = await beginMutation(tx, token, data.idempotencyKey, data.op, data);
    if (previous) return previous.result as AdminMutationResult;
    await lockAppointmentMaster(tx, data.masterId); await expireMasterHolds(tx, data.masterId); await requireUnarchived(tx, "master", data.masterId);
    const now = await databaseNow(tx); const before = await readSchedule(tx, data.masterId);
    let id = data.masterId;
    if (data.op === "weekly") {
      await tx.weeklySchedule.deleteMany({ where: { masterId: data.masterId } });
      await tx.weeklySchedule.createMany({ data: data.intervals.map(row => ({ masterId: data.masterId, ...row })) });
    } else {
      const localDate = new Date(data.localDate + "T00:00:00Z");
      const where = { masterId_localDate: { masterId: data.masterId, localDate } };
      if (data.op === "removeException") {
        const existing = await tx.scheduleException.findUnique({ where, select: { id: true } });
        if (!existing) throw new AdminError("Исключение не найдено.", 404);
        id = existing.id; await tx.scheduleException.delete({ where });
      } else {
        const exception = await tx.scheduleException.upsert({ where, create: { masterId: data.masterId, localDate, kind: data.kind, reason: data.reason ?? null }, update: { kind: data.kind, reason: data.reason ?? null } });
        id = exception.id; await tx.scheduleExceptionInterval.deleteMany({ where: { scheduleExceptionId: id } });
        await tx.scheduleExceptionInterval.createMany({ data: data.intervals.map(row => ({ scheduleExceptionId: id, ...row })) });
      }
    }
    await assertScheduleKeepsAppointments(tx, data.masterId, now);
    const after = await readSchedule(tx, data.masterId);
    const result = { id, entityType: data.op === "weekly" ? "WeeklySchedule" : "ScheduleException", operation: data.op };
    return finishMutation(tx, data, actor.id, payloadFingerprint, result, before, after);
  }, true);
}
