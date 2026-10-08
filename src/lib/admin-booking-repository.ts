import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminError, assertAdminSession, type AdminActor } from "./admin-auth";
import { databaseNow, expireMasterHolds, lockAppointmentMaster } from "./appointment-repository";
import { AvailabilityRequestError, readDatabaseAvailabilityContext } from "./availability-repository";
import { calculateAvailability } from "./availability-engine";
import { CatalogSelectionError } from "./catalog-rules";
import { createContactSchema } from "./contact-validation";
import { getDatabase } from "./db";
import { buildDemoQuote, DemoQuoteError } from "./demo-quote";
import { paymentViewSelect, toPaymentView, type PaymentView } from "./payment-types";
import { addCalendarDays, salonDateString, salonDateTimeToInstant, validCalendarDate } from "./salon-time";
import type { AppointmentStatus } from "./appointment-types";

export type AdminDatabaseOptions = { database?: PrismaClient };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const date = z.string().refine(validCalendarDate);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const reason = z.string().trim().min(3).max(2000);
const expectedUpdatedAt = z.string().datetime({ offset: true });
const existing = { idempotencyKey: uuid, id: uuid, expectedUpdatedAt };
export const adminAppointmentMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), idempotencyKey: uuid, variantIds: z.array(uuid).min(1).max(20).refine(ids => new Set(ids).size === ids.length),
    masterId: uuid, date, time, contacts: z.unknown(), consent: z.literal(true), confirmWithoutPayment: z.boolean().default(false), reason: reason.optional(), adminNotes: z.string().trim().max(10000).optional() }).strict(),
  z.object({ action: z.literal("reschedule"), ...existing, masterId: uuid, date, time, reason }).strict(),
  z.object({ action: z.literal("cancel"), ...existing, reason }).strict(),
  z.object({ action: z.literal("status"), ...existing, status: z.enum(["COMPLETED", "NO_SHOW"]) }).strict(),
  z.object({ action: z.literal("notes"), ...existing, adminNotes: z.string().trim().max(10000) }).strict(),
]);
export type AdminAppointmentMutation = z.input<typeof adminAppointmentMutationSchema>;
export const adminAppointmentSelect = {
  id: true, number: true, source: true, status: true, customerId: true, masterId: true, masterNameSnapshot: true,
  startsAt: true, endsAt: true, occupiedUntil: true, holdExpiresAt: true, updatedAt: true, createdAt: true, cancelledAt: true,
  cancellationReason: true, customerNameSnapshot: true, customerPhoneSnapshot: true, customerEmailSnapshot: true, customerComment: true,
  adminNotes: true, totalPriceMinor: true, totalDurationMinutes: true, totalBufferMinutes: true, prepaymentRequiredMinor: true, currency: true, timezoneSnapshot: true,
  items: { select: { serviceVariantId: true, serviceNameSnapshot: true, variantNameSnapshot: true, priceMinorSnapshot: true, durationMinutesSnapshot: true, bufferMinutesSnapshot: true }, orderBy: { position: "asc" } },
  payments: { select: paymentViewSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} as const satisfies Prisma.AppointmentSelect;
type StoredAppointment = Prisma.AppointmentGetPayload<{ select: typeof adminAppointmentSelect }>;
export type AdminAppointmentView = {
  id: string; number: number; source: "CLIENT" | "ADMIN"; status: AppointmentStatus; customerId: string; masterId: string; masterName: string;
  startsAt: string; endsAt: string; occupiedUntil: string; holdExpiresAt: string | null; updatedAt: string; createdAt: string; cancelledAt: string | null; cancellationReason: string | null;
  customerName: string; customerPhone: string; customerEmail: string; customerComment: string; adminNotes: string;
  totalPriceMinor: number; totalDurationMinutes: number; totalBufferMinutes: number; prepaymentRequiredMinor: number; currency: string; timezone: string;
  paidMinor: number; remainingMinor: number; payments: PaymentView[];
  items: { variantId: string; serviceName: string; variantName: string; priceMinor: number; durationMinutes: number; bufferMinutes: number }[];
};
export function toAdminAppointment(row: StoredAppointment): AdminAppointmentView {
  const payments = row.payments.map(toPaymentView);
  const paidMinor = payments.reduce((sum, item) => ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(item.status) ? sum + item.amountMinor - item.refundedAmountMinor : sum, 0);
  return { id: row.id, number: row.number, source: row.source, status: row.status, customerId: row.customerId, masterId: row.masterId, masterName: row.masterNameSnapshot,
    startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), occupiedUntil: row.occupiedUntil.toISOString(), holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null, cancellationReason: row.cancellationReason,
    customerName: row.customerNameSnapshot, customerPhone: row.customerPhoneSnapshot, customerEmail: row.customerEmailSnapshot ?? "", customerComment: row.customerComment ?? "", adminNotes: row.adminNotes ?? "",
    totalPriceMinor: row.totalPriceMinor, totalDurationMinutes: row.totalDurationMinutes, totalBufferMinutes: row.totalBufferMinutes, prepaymentRequiredMinor: row.prepaymentRequiredMinor,
    currency: row.currency, timezone: row.timezoneSnapshot, paidMinor, remainingMinor: Math.max(0, row.totalPriceMinor - paidMinor), payments,
    items: row.items.map(item => ({ variantId: item.serviceVariantId, serviceName: item.serviceNameSnapshot, variantName: item.variantNameSnapshot, priceMinor: item.priceMinorSnapshot, durationMinutes: item.durationMinutesSnapshot, bufferMinutes: item.bufferMinutesSnapshot })) };
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function errorCodes(error: unknown) {
  const codes = new Set<string>(); const seen = new Set<object>();
  function walk(value: unknown, depth: number) {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 7) return;
    seen.add(value); const obj = value as Record<string, unknown>;
    for (const key of ["code", "sqlState", "sqlstate", "originalCode"]) if (typeof obj[key] === "string") codes.add(obj[key]);
    for (const key of ["cause", "meta", "driverAdapterError", "originalError", "error"]) walk(obj[key], depth + 1);
  }
  walk(error, 0); return codes;
}
function safeError(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  if (error instanceof DemoQuoteError) return new AdminError(error.message, error.status);
  if (error instanceof AvailabilityRequestError || error instanceof CatalogSelectionError) return new AdminError(error.message, 400);
  if (errorCodes(error).has("23P01")) return new AdminError("Это время уже занято. Обновите календарь и выберите другой интервал.", 409);
  return new AdminError("Операция временно недоступна. Повторите попытку.", 503);
}
export async function adminReadTransaction<T>(token: string | null, options: AdminDatabaseOptions, operation: (tx: Prisma.TransactionClient, actor: AdminActor, now: Date) => Promise<T>): Promise<T> {
  let database: PrismaClient;
  try { database = options.database ?? getDatabase(); } catch (error) { throw safeError(error); }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await database.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '12s'`;
        const actor = await assertAdminSession(tx, token);
        return operation(tx, actor, await databaseNow(tx));
      }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    } catch (error) {
      const retry = ["P2034", "40001", "40P01", "P2002", "23505"].some(code => errorCodes(error).has(code));
      if (!(error instanceof AdminError) && retry && attempt < 7) { await new Promise(resolve => setTimeout(resolve, randomInt(20, 100) + attempt * 20)); continue; }
      throw safeError(error);
    }
  }
  throw new AdminError("Операция временно недоступна. Повторите попытку.", 503);
}
export async function adminMutationTransaction<T>(token: string | null, input: { idempotencyKey: string; action: string }, options: AdminDatabaseOptions,
  operation: (tx: Prisma.TransactionClient, actor: AdminActor, now: Date) => Promise<T>): Promise<T> {
  return adminReadTransaction(token, options, async (tx, actor, now) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"romeo:admin-mutation:" + input.idempotencyKey}, 0))`;
    const fingerprint = hash(JSON.stringify(input));
    const previous = await tx.adminMutation.findUnique({ where: { id: input.idempotencyKey } });
    if (previous) {
      if (previous.actorId !== actor.id || previous.action !== input.action || previous.payloadFingerprint !== fingerprint) throw new AdminError("Этот запрос уже использован с другими данными. Обновите страницу.", 409);
      return previous.result as T;
    }
    const result = await operation(tx, actor, now);
    await tx.adminMutation.create({ data: { id: input.idempotencyKey, actorId: actor.id, action: input.action, payloadFingerprint: fingerprint, result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue, createdAt: now } });
    return result;
  });
}
export async function adminAudit(tx: Prisma.TransactionClient, actor: AdminActor, action: string, entityType: string, entityId: string,
  idempotencyKey: string, before: unknown, after: unknown, reasonValue?: string) {
  await tx.auditLog.create({ data: { actorId: actor.id, action, entityType, entityId, requestId: idempotencyKey,
    changes: JSON.parse(JSON.stringify({ before, after, ...(reasonValue ? { reason: reasonValue } : {}) })) as Prisma.InputJsonValue } });
}
export function assertUpdatedAt(actual: Date, expected: string) {
  if (actual.getTime() !== Date.parse(expected)) throw new AdminError("Данные уже изменились. Обновите страницу перед сохранением.", 409);
}
async function advanceUpdatedAt(tx: Prisma.TransactionClient, previous: Date, now: Date): Promise<Date> {
  // Millisecond timestamps must change even for two legitimate writes within
  // the same DB clock tick, otherwise optimistic concurrency misses one edit.
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}
const querySchema = z.object({ from: date, to: date, masterId: uuid.optional(), status: z.enum(["WAITING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"]).optional() });
export async function getAdminAppointments(token: string | null, input: unknown, options: AdminDatabaseOptions = {}) {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new AdminError("Проверьте период и фильтры календаря.", 400);
  const query = parsed.data;
  if (query.to < query.from || Date.parse(query.to) - Date.parse(query.from) > 93 * 86400000) throw new AdminError("Выберите период до трёх месяцев.", 400);
  return adminReadTransaction(token, options, async (tx, _actor, now) => {
    const settings = await tx.salonSettings.findUniqueOrThrow({ where: { id: "salon" }, select: { timezone: true } });
    const from = salonDateTimeToInstant(query.from, "00:00", settings.timezone);
    const until = salonDateTimeToInstant(addCalendarDays(query.to, 1), "00:00", settings.timezone);
    if (!from || !until) throw new AdminError("Выберите корректный период календаря.", 400);
    const rows = await tx.appointment.findMany({ where: { startsAt: { gte: from, lt: until }, ...(query.masterId ? { masterId: query.masterId } : {}), ...(query.status ? { status: query.status } : {}) }, select: adminAppointmentSelect, orderBy: [{ startsAt: "asc" }, { id: "asc" }], take: 501 });
    return { serverNow: now.toISOString(), timezone: settings.timezone, appointments: rows.slice(0, 500).map(toAdminAppointment), truncated: rows.length > 500,
      masters: await tx.master.findMany({ select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }) };
  });
}
async function createManual(tx: Prisma.TransactionClient, actor: AdminActor, now: Date, request: Extract<z.output<typeof adminAppointmentMutationSchema>, { action: "create" }>) {
  await lockAppointmentMaster(tx, request.masterId);
  await expireMasterHolds(tx, request.masterId);
  const { catalog, availability } = await readDatabaseAvailabilityContext(tx, request, now);
  const salon = catalog.salon!;
  const contact = createContactSchema(salon.country).safeParse(request.contacts);
  if (!contact.success) throw new AdminError("Проверьте имя, телефон и контакты клиента.", 400);
  const quote = buildDemoQuote({ ...request, contacts: contact.data }, { salon, catalog, slots: availability.slots });
  if (request.confirmWithoutPayment && quote.prepaymentMinor > 0 && !request.reason) throw new AdminError("Укажите причину подтверждения без предоплаты.", 400);
  const waiting = quote.prepaymentMinor > 0 && !request.confirmWithoutPayment;
  const customer = await tx.customer.upsert({ where: { phoneNormalized: contact.data.phone }, create: { name: contact.data.name, phoneNormalized: contact.data.phone, email: contact.data.email || null }, update: {}, select: { id: true } });
  return tx.appointment.create({ data: {
    customerId: customer.id, masterId: request.masterId, createdByAdminId: actor.id, source: "ADMIN", status: waiting ? "WAITING_PAYMENT" : "CONFIRMED",
    startsAt: new Date(quote.startsAt), endsAt: new Date(quote.endsAt), occupiedUntil: new Date(Date.parse(quote.endsAt) + (quote.totalBufferMinutes ?? 0) * 60000),
    holdExpiresAt: waiting ? new Date(now.getTime() + salon.policy.holdDurationMinutes * 60000) : null, confirmedAt: waiting ? null : now,
    idempotencyKey: request.idempotencyKey, publicAccessTokenHash: hash(randomBytes(32).toString("base64url")), requestFingerprint: hash(JSON.stringify(request)),
    salonNameSnapshot: salon.name, salonAddressSnapshot: salon.address, salonPhoneSnapshot: salon.phone, phoneCountrySnapshot: salon.country,
    masterNameSnapshot: quote.master.name, customerNameSnapshot: contact.data.name, customerPhoneSnapshot: contact.data.phone, customerEmailSnapshot: contact.data.email || null,
    customerComment: contact.data.comment || null, adminNotes: request.adminNotes || null, timezoneSnapshot: salon.timezone, currency: quote.currency,
    totalPriceMinor: quote.totalPriceMinor, totalDurationMinutes: quote.totalDurationMinutes, totalBufferMinutes: quote.totalBufferMinutes ?? 0,
    prepaymentModeSnapshot: salon.policy.prepaymentMode, prepaymentRequiredMinor: quote.prepaymentMinor,
    prepaymentFixedMinorSnapshot: salon.policy.prepaymentMode === "FIXED" ? salon.policy.prepaymentFixedMinor : null,
    prepaymentPercentageBpsSnapshot: salon.policy.prepaymentMode === "PERCENTAGE" ? Math.round(salon.policy.prepaymentPercentage * 100) : null,
    bookingTermsVersion: hash(salon.policy.bookingTerms), privacyTermsVersion: hash(salon.policy.privacyTerms), bookingTermsSnapshot: salon.policy.bookingTerms, privacyTermsSnapshot: salon.policy.privacyTerms,
    consentRecordedAt: now, createdAt: now, updatedAt: now,
    items: { create: quote.items.map((item, position) => ({ position, serviceVariantId: item.variantId, serviceNameSnapshot: item.serviceName, variantNameSnapshot: item.variantName,
      priceMinorSnapshot: item.priceMinor, durationMinutesSnapshot: item.durationMinutes, bufferMinutesSnapshot: item.bufferMinutes ?? 0 })) },
  }, select: adminAppointmentSelect });
}
async function rescheduleInterval(tx: Prisma.TransactionClient, row: StoredAppointment, request: { masterId: string; date: string; time: string }, now: Date) {
  const [settings, master] = await Promise.all([tx.salonSettings.findUniqueOrThrow({ where: { id: "salon" } }), tx.master.findUnique({ where: { id: request.masterId }, select: { name: true, isBookable: true, archivedAt: true } })]);
  if (!master?.isBookable || master.archivedAt) throw new AdminError("Мастер недоступен для записи.", 409);
  // An archived catalogue entry remains an appointment snapshot. The new
  // master must still explicitly perform every original variant.
  const variants = [...new Set(row.items.map(item => item.serviceVariantId))];
  const assignments = await tx.masterService.count({ where: { masterId: request.masterId, serviceVariantId: { in: variants }, isActive: true, archivedAt: null } });
  if (assignments !== variants.length) throw new AdminError("Новый мастер выполняет не все услуги этой записи.", 409);
  const today = salonDateString(now, settings.timezone);
  if (request.date < today || request.date > addCalendarDays(today, settings.bookingHorizonDays - 1)) throw new AdminError("Дата находится вне периода записи.", 409);
  const [weeklyIntervals, exceptions, occupied] = await Promise.all([
    tx.weeklySchedule.findMany({ where: { masterId: request.masterId }, select: { dayOfWeek: true, startMinute: true, endMinute: true } }),
    tx.scheduleException.findMany({ where: { masterId: request.masterId, localDate: new Date(request.date + "T00:00:00Z") }, select: { localDate: true, kind: true, intervals: { select: { kind: true, startMinute: true, endMinute: true } } } }),
    tx.appointment.findMany({ where: { masterId: request.masterId, id: { not: row.id }, OR: [{ status: "CONFIRMED" }, { status: "WAITING_PAYMENT", holdExpiresAt: { gt: now } }] }, select: { startsAt: true, occupiedUntil: true } }),
  ]);
  const result = calculateAvailability({ timezone: settings.timezone, policy: settings, durationMinutes: row.totalDurationMinutes, bufferMinutes: row.totalBufferMinutes,
    weeklyIntervals, exceptionRows: exceptions.map(item => ({ date: item.localDate.toISOString().slice(0, 10), kind: item.kind, intervals: item.intervals })),
    occupied: occupied.map(item => ({ startAt: item.startsAt, endAt: item.occupiedUntil })), date: request.date, now });
  const slot = result.slots.find(item => item.time === request.time && item.status === "available");
  if (!slot) throw new AdminError("Весь интервал с техническим перерывом недоступен. Выберите другое время.", 409);
  return { masterId: request.masterId, masterNameSnapshot: master.name, startsAt: new Date(slot.startAt), endsAt: new Date(slot.endAt), occupiedUntil: new Date(slot.blockedUntil), timezoneSnapshot: settings.timezone };
}
export async function mutateAdminAppointment(token: string | null, input: unknown, options: AdminDatabaseOptions = {}): Promise<{ appointment: AdminAppointmentView; priceDifferenceMinor: number }> {
  const parsed = adminAppointmentMutationSchema.safeParse(input);
  if (!parsed.success) throw new AdminError("Проверьте данные записи, причину изменения и актуальность карточки.", 400);
  const request = parsed.data;
  return adminMutationTransaction(token, request, options, async (tx, actor, now) => {
    if (request.action === "create") {
      const row = await createManual(tx, actor, now, request);
      const after = toAdminAppointment(row);
      await adminAudit(tx, actor, "APPOINTMENT_CREATE", "Appointment", row.id, request.idempotencyKey, null, after, request.reason);
      return { appointment: after, priceDifferenceMinor: 0 };
    }
    const initial = await tx.appointment.findUnique({ where: { id: request.id }, select: { masterId: true } });
    if (!initial) throw new AdminError("Запись не найдена.", 404);
    for (const masterId of [...new Set([initial.masterId, ...(request.action === "reschedule" ? [request.masterId] : [])])].sort()) {
      await lockAppointmentMaster(tx, masterId); await expireMasterHolds(tx, masterId);
    }
    const row = await tx.appointment.findUniqueOrThrow({ where: { id: request.id }, select: adminAppointmentSelect });
    assertUpdatedAt(row.updatedAt, request.expectedUpdatedAt);
    const before = toAdminAppointment(row);
    let data: Prisma.AppointmentUpdateInput = { updatedAt: await advanceUpdatedAt(tx, row.updatedAt, now) };
    if (request.action === "notes") data.adminNotes = request.adminNotes || null;
    else if (request.action === "cancel") {
      if (!["CONFIRMED", "WAITING_PAYMENT"].includes(row.status)) throw new AdminError("Отмена доступна только для действующей записи.", 409);
      await tx.payment.updateMany({ where: { appointmentId: row.id, status: "PENDING" }, data: { status: "CANCELLED", updatedAt: now } });
      await tx.payment.updateMany({ where: { appointmentId: row.id, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] } }, data: { needsAttention: true, attentionReason: "CANCELLED_PAID_APPOINTMENT", updatedAt: now } });
      data = { ...data, status: "CANCELLED", cancelledAt: now, cancellationReason: request.reason };
    } else if (request.action === "status") {
      if (row.status !== "CONFIRMED") throw new AdminError("Завершение и неявка доступны только для подтверждённой записи.", 409);
      if ((request.status === "COMPLETED" ? row.endsAt : row.startsAt) > now) throw new AdminError("Этот визит ещё не состоялся. Обновите статус после его начала или окончания.", 409);
      data.status = request.status;
    } else {
      if (!["CONFIRMED", "WAITING_PAYMENT"].includes(row.status)) throw new AdminError("Перенос доступен только для действующей записи.", 409);
      data = { ...data, ...await rescheduleInterval(tx, row, request, now) };
    }
    const after = toAdminAppointment(await tx.appointment.update({ where: { id: row.id }, data, select: adminAppointmentSelect }));
    await adminAudit(tx, actor, "APPOINTMENT_" + request.action.toUpperCase(), "Appointment", row.id, request.idempotencyKey, before, after, "reason" in request ? request.reason : undefined);
    return { appointment: after, priceDifferenceMinor: 0 };
  });
}
