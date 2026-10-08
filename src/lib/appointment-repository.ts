import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AppointmentConditions, AppointmentView } from "./appointment-types";
import { AvailabilityRequestError, readDatabaseAvailabilityContext } from "./availability-repository";
import { CatalogSelectionError } from "./catalog-rules";
import { createContactSchema, contactFieldErrors } from "./contact-validation";
import { getDatabase } from "./db";
import { buildDemoQuote, DemoQuoteError } from "./demo-quote";
import { validCalendarDate } from "./salon-time";
import { paymentViewSelect, toPaymentView } from "./payment-types";
import { testPaymentAvailability } from "./payment-configuration";

export class AppointmentError extends Error {
  constructor(message: string, public readonly status = 400, public readonly fieldErrors?: Record<string, string>) { super(message); this.name = "AppointmentError"; }
}

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const accessTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const conditionsSchema = z.object({
  totalPriceMinor: z.number().int().nonnegative(), totalDurationMinutes: z.number().int().positive(), totalBufferMinutes: z.number().int().nonnegative(),
  prepaymentRequiredMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(64),
  bookingTermsVersion: z.string().regex(/^[a-f0-9]{64}$/), privacyTermsVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
const requestSchema = z.object({
  variantIds: z.array(uuid).min(1).max(20).refine(values => new Set(values).size === values.length, "Уберите повторяющиеся услуги"),
  masterId: uuid, date: z.string().refine(validCalendarDate, "Выберите корректную дату"), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  contacts: z.unknown(), consent: z.literal(true), idempotencyKey: uuid, accessToken: accessTokenSchema, expectedConditions: conditionsSchema.optional(),
});
type ParsedRequest = z.output<typeof requestSchema>;

const viewSelect = {
  id: true, number: true, status: true, createdAt: true, holdExpiresAt: true, confirmedAt: true,
  salonNameSnapshot: true, salonAddressSnapshot: true, salonPhoneSnapshot: true, masterNameSnapshot: true,
  timezoneSnapshot: true, currency: true, startsAt: true, endsAt: true, occupiedUntil: true,
  totalPriceMinor: true, totalDurationMinutes: true, totalBufferMinutes: true, prepaymentRequiredMinor: true,
  customerNameSnapshot: true, customerPhoneSnapshot: true, customerEmailSnapshot: true, customerComment: true,
  bookingTermsSnapshot: true, privacyTermsSnapshot: true,
  items: { select: { serviceNameSnapshot: true, variantNameSnapshot: true, priceMinorSnapshot: true, durationMinutesSnapshot: true, bufferMinutesSnapshot: true }, orderBy: { position: "asc" } },
  payments: { select: paymentViewSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} as const satisfies Prisma.AppointmentSelect;
type StoredView = Prisma.AppointmentGetPayload<{ select: typeof viewSelect }>;

function hash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function equalHash(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function normalizedRequest(input: ParsedRequest, country: string) {
  const parsed = createContactSchema(country).safeParse(input.contacts);
  if (!parsed.success) throw new AppointmentError("Проверьте контактные данные и согласие с условиями записи", 400, contactFieldErrors(parsed.error));
  const normalized = { variantIds: [...input.variantIds].sort(), masterId: input.masterId, date: input.date, time: input.time,
    contacts: parsed.data, consent: true, ...(input.expectedConditions ? { expectedConditions: input.expectedConditions } : {}) };
  return { contacts: parsed.data, fingerprint: hash(JSON.stringify(normalized)) };
}
function appointmentView(row: StoredView, now: Date, isDemo: boolean): AppointmentView {
  const payments = row.payments.map(toPaymentView);
  const paidMinor = payments.reduce((sum, payment) => ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(payment.status)
    ? sum + payment.amountMinor - payment.refundedAmountMinor : sum, 0);
  const available = testPaymentAvailability(isDemo);
  const canCreate = available.mode === "TEST" && row.status === "WAITING_PAYMENT" && Boolean(row.holdExpiresAt && row.holdExpiresAt > now)
    && row.prepaymentRequiredMinor > paidMinor && !payments.some(payment => payment.status === "PENDING");
  return { source: "database", id: row.id, number: row.number, status: row.status, serverNow: now.toISOString(), createdAt: row.createdAt.toISOString(),
    payments, paidMinor, remainingMinor: Math.max(0, row.totalPriceMinor - paidMinor),
    paymentAvailability: { ...available, canCreate, ...(!canCreate && available.mode === "TEST" ? { reason: row.prepaymentRequiredMinor === 0 ? "Предоплата не требуется." : payments.some(payment => payment.status === "PENDING") ? "Платёж уже создан." : "Новый платёж для этой записи недоступен." } : {}) },
    holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null, confirmedAt: row.confirmedAt?.toISOString() ?? null,
    details: { salonName: row.salonNameSnapshot, salonAddress: row.salonAddressSnapshot, salonPhone: row.salonPhoneSnapshot, masterName: row.masterNameSnapshot,
      timezone: row.timezoneSnapshot, currency: row.currency, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), occupiedUntil: row.occupiedUntil.toISOString(),
      totalPriceMinor: row.totalPriceMinor, totalDurationMinutes: row.totalDurationMinutes, totalBufferMinutes: row.totalBufferMinutes, prepaymentRequiredMinor: row.prepaymentRequiredMinor,
      items: row.items.map(item => ({ serviceName: item.serviceNameSnapshot, variantName: item.variantNameSnapshot, priceMinor: item.priceMinorSnapshot, durationMinutes: item.durationMinutesSnapshot, bufferMinutes: item.bufferMinutesSnapshot })),
      contacts: { name: row.customerNameSnapshot, phone: row.customerPhoneSnapshot, email: row.customerEmailSnapshot ?? "", comment: row.customerComment ?? "" },
      bookingTerms: row.bookingTermsSnapshot, privacyTerms: row.privacyTermsSnapshot } };
}
export async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  // An epoch value is independent of the connection's timezone and of a raw
  // timestamp decoder. All deadlines still originate from PostgreSQL's clock.
  const rows = await tx.$queryRaw<{ epochMilliseconds: number }[]>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision AS "epochMilliseconds"`;
  return new Date(rows[0].epochMilliseconds);
}

// Every future admin operation that changes a master's schedule or occupied
// intervals must take this same lock. Idempotency lock is always acquired first.
export async function lockAppointmentMaster(tx: Prisma.TransactionClient, masterId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'romeo:appointment-master:' + masterId.toLowerCase()}, 0))`;
}
export async function expireMasterHolds(tx: Prisma.TransactionClient, masterId: string) {
  await tx.$executeRaw`UPDATE "Payment" SET "status" = 'EXPIRED', "updatedAt" = clock_timestamp()
    WHERE "status" = 'PENDING' AND "expiresAt" <= clock_timestamp() AND "appointmentId" IN (SELECT "id" FROM "Appointment" WHERE "masterId" = ${masterId}::uuid)`;
  return tx.$executeRaw`UPDATE "Appointment" SET "status" = 'EXPIRED', "updatedAt" = clock_timestamp()
    WHERE "masterId" = ${masterId}::uuid AND "status" = 'WAITING_PAYMENT' AND "holdExpiresAt" <= clock_timestamp()`;
}

/** Database clock and status update make expiry independent of any browser. */
export async function expireAppointmentHolds(databaseOverride?: PrismaClient): Promise<number> {
  try {
    return await (databaseOverride ?? getDatabase()).$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Payment" SET "status" = 'EXPIRED', "updatedAt" = clock_timestamp() WHERE "status" = 'PENDING' AND "expiresAt" <= clock_timestamp()`;
      return tx.$executeRaw`UPDATE "Appointment" SET "status" = 'EXPIRED', "updatedAt" = clock_timestamp() WHERE "status" = 'WAITING_PAYMENT' AND "holdExpiresAt" <= clock_timestamp()`;
    });
  } catch { throw new AppointmentError("Не удалось проверить истёкшие брони. Повторите попытку позже.", 503); }
}

function errorCodes(error: unknown): Set<string> {
  const codes = new Set<string>(); const visited = new Set<object>();
  function walk(value: unknown, depth: number) {
    if (!value || typeof value !== "object" || depth > 6 || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["code", "sqlState", "sqlstate", "originalCode"]) if (typeof record[key] === "string") codes.add(record[key]);
    for (const key of ["cause", "meta", "driverAdapterError", "originalError", "error"]) walk(record[key], depth + 1);
  }
  walk(error, 0); return codes;
}
function safeError(error: unknown): AppointmentError {
  if (error instanceof AppointmentError) return error;
  if (error instanceof DemoQuoteError) return new AppointmentError(error.message, error.status, error.fieldErrors);
  if (error instanceof AvailabilityRequestError || error instanceof CatalogSelectionError) return new AppointmentError(error.message, 400, error.fieldErrors);
  if (errorCodes(error).has("23P01")) return new AppointmentError("Это время уже занято. Выберите другой интервал.", 409, { time: "Выберите свободное время" });
  return new AppointmentError("Запись временно недоступна. Повторите попытку через несколько секунд.", 503);
}

export async function createAppointment(input: unknown, options: { database?: PrismaClient } = {}): Promise<AppointmentView> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    const messages: Record<string, string> = { variantIds: "Проверьте выбранные услуги", masterId: "Выберите доступного мастера", date: "Выберите корректную дату",
      time: "Выберите корректное время", contacts: "Заполните контактные данные", consent: "Подтвердите согласие с условиями записи",
      idempotencyKey: "Начните проверку записи заново", accessToken: "Начните проверку записи заново", expectedConditions: "Проверьте условия записи заново" };
    const fields = Object.fromEntries(parsed.error.issues.map(issue => {
      const field = String(issue.path[0] ?? "form"); return [field, messages[field] ?? "Проверьте данные записи"];
    }));
    throw new AppointmentError("Проверьте выбранные услуги, дату, контакты и согласие с условиями записи", 400, fields);
  }
  const request = parsed.data;
  const tokenHash = hash(request.accessToken);
  let database: PrismaClient;
  try { database = options.database ?? getDatabase(); } catch (error) { throw safeError(error); }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await database.$transaction(async tx => {
        // PrismaPg raw/model timestamp decoding must see UTC even when the
        // PostgreSQL cluster uses the salon's local timezone by default.
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '12s'`;
        // Serializable snapshots may precede a wait on a lock. Retrying a
        // serialization/unique race obtains a new snapshot after the winner.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'romeo:appointment-idempotency:' + request.idempotencyKey}, 0))`;
        const previous = await tx.appointment.findUnique({ where: { idempotencyKey: request.idempotencyKey },
          select: { id: true, masterId: true, publicAccessTokenHash: true, requestFingerprint: true, phoneCountrySnapshot: true } });
        if (previous) {
          if (!equalHash(previous.publicAccessTokenHash, tokenHash)) throw new AppointmentError("Этот запрос уже использован. Начните проверку записи заново.", 409);
          let replay;
          try { replay = normalizedRequest(request, previous.phoneCountrySnapshot); }
          catch (error) {
            if (error instanceof AppointmentError) throw new AppointmentError("Этот запрос уже использован с другими данными. Проверьте запись заново.", 409);
            throw error;
          }
          if (!equalHash(previous.requestFingerprint, replay.fingerprint)) throw new AppointmentError("Этот запрос уже использован с другими данными. Проверьте запись заново.", 409);
          await lockAppointmentMaster(tx, previous.masterId);
          const now = await databaseNow(tx);
          await expireMasterHolds(tx, previous.masterId);
          const row = await tx.appointment.findUniqueOrThrow({ where: { id: previous.id }, select: viewSelect });
          return appointmentView(row, now, Boolean((await tx.salonSettings.findUnique({ where: { id: "salon" }, select: { isDemo: true } }))?.isDemo));
        }
        if (await tx.appointment.findUnique({ where: { publicAccessTokenHash: tokenHash }, select: { id: true } })) {
          throw new AppointmentError("Этот запрос уже использован. Начните проверку записи заново.", 409);
        }
        await lockAppointmentMaster(tx, request.masterId);
        const now = await databaseNow(tx);
        await expireMasterHolds(tx, request.masterId);
        const { catalog, availability } = await readDatabaseAvailabilityContext(tx, request, now);
        const salon = catalog.salon!;
        const normalized = normalizedRequest(request, salon.country);
        const quote = buildDemoQuote({ ...request, contacts: normalized.contacts }, { salon, catalog, slots: availability.slots });
        const totalBufferMinutes = quote.totalBufferMinutes ?? 0;
        const currentConditions: AppointmentConditions = { totalPriceMinor: quote.totalPriceMinor, totalDurationMinutes: quote.totalDurationMinutes,
          totalBufferMinutes, prepaymentRequiredMinor: quote.prepaymentMinor, currency: quote.currency, timezone: salon.timezone,
          bookingTermsVersion: hash(salon.policy.bookingTerms), privacyTermsVersion: hash(salon.policy.privacyTerms) };
        if (request.expectedConditions && (Object.keys(currentConditions) as (keyof AppointmentConditions)[]).some(key => request.expectedConditions![key] !== currentConditions[key])) {
          throw new AppointmentError("Условия изменились. Проверьте запись заново.", 409);
        }
        const waiting = quote.prepaymentMinor > 0;
        const customer = await tx.customer.upsert({ where: { phoneNormalized: normalized.contacts.phone },
          create: { name: normalized.contacts.name, phoneNormalized: normalized.contacts.phone, email: normalized.contacts.email || null }, update: {}, select: { id: true } });
        const row = await tx.appointment.create({ data: {
          customerId: customer.id, masterId: request.masterId, source: "CLIENT", status: waiting ? "WAITING_PAYMENT" : "CONFIRMED",
          startsAt: new Date(quote.startsAt), endsAt: new Date(quote.endsAt), occupiedUntil: new Date(Date.parse(quote.endsAt) + totalBufferMinutes * 60_000),
          holdExpiresAt: waiting ? new Date(now.getTime() + salon.policy.holdDurationMinutes * 60_000) : null, confirmedAt: waiting ? null : now,
          idempotencyKey: request.idempotencyKey, publicAccessTokenHash: tokenHash, requestFingerprint: normalized.fingerprint,
          salonNameSnapshot: salon.name, salonAddressSnapshot: salon.address, salonPhoneSnapshot: salon.phone, phoneCountrySnapshot: salon.country,
          masterNameSnapshot: quote.master.name, customerNameSnapshot: normalized.contacts.name, customerPhoneSnapshot: normalized.contacts.phone,
          customerEmailSnapshot: normalized.contacts.email || null, customerComment: normalized.contacts.comment || null,
          timezoneSnapshot: salon.timezone, currency: quote.currency, totalPriceMinor: quote.totalPriceMinor, totalDurationMinutes: quote.totalDurationMinutes,
          totalBufferMinutes, prepaymentRequiredMinor: quote.prepaymentMinor, prepaymentModeSnapshot: salon.policy.prepaymentMode,
          prepaymentFixedMinorSnapshot: salon.policy.prepaymentMode === "FIXED" ? salon.policy.prepaymentFixedMinor : null,
          prepaymentPercentageBpsSnapshot: salon.policy.prepaymentMode === "PERCENTAGE" ? Math.round(salon.policy.prepaymentPercentage * 100) : null,
          bookingTermsVersion: hash(salon.policy.bookingTerms), privacyTermsVersion: hash(salon.policy.privacyTerms),
          bookingTermsSnapshot: salon.policy.bookingTerms, privacyTermsSnapshot: salon.policy.privacyTerms,
          consentRecordedAt: now, createdAt: now, updatedAt: now,
          items: { create: quote.items.map((item, position) => ({ position, serviceVariantId: item.variantId, serviceNameSnapshot: item.serviceName,
            variantNameSnapshot: item.variantName, priceMinorSnapshot: item.priceMinor, durationMinutesSnapshot: item.durationMinutes, bufferMinutesSnapshot: item.bufferMinutes ?? 0 })) },
        }, select: viewSelect });
        return appointmentView(row, now, Boolean((await tx.salonSettings.findUnique({ where: { id: "salon" }, select: { isDemo: true } }))?.isDemo));
      }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (error instanceof AppointmentError || error instanceof DemoQuoteError || error instanceof AvailabilityRequestError || error instanceof CatalogSelectionError) throw safeError(error);
      const codes = errorCodes(error);
      const retryable = ["P2034", "40001", "40P01", "P2002", "23505"].some(code => codes.has(code));
      if (retryable && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1))); continue; }
      if (codes.has("P2002") || codes.has("23505")) throw new AppointmentError("Этот запрос конфликтует с уже созданной записью. Проверьте запись заново.", 409);
      throw safeError(error);
    }
  }
  throw new AppointmentError("Запись временно недоступна. Повторите попытку.", 503);
}

export async function getAppointment(id: string, token: string, options: { database?: PrismaClient } = {}): Promise<AppointmentView> {
  const parsedId = uuid.safeParse(id);
  if (!parsedId.success || !accessTokenSchema.safeParse(token).success) throw new AppointmentError("Запись не найдена.", 404);
  try {
    const database = options.database ?? getDatabase();
    const tokenHash = hash(token);
    return await database.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      const now = await databaseNow(tx);
      await tx.$executeRaw`UPDATE "Payment" SET "status" = 'EXPIRED', "updatedAt" = clock_timestamp()
        WHERE "status" = 'PENDING' AND "expiresAt" <= ${now} AND "appointmentId" IN (SELECT "id" FROM "Appointment" WHERE "id" = ${parsedId.data}::uuid AND "publicAccessTokenHash" = ${tokenHash})`;
      await tx.$executeRaw`UPDATE "Appointment" SET "status" = 'EXPIRED', "updatedAt" = clock_timestamp()
        WHERE "id" = ${parsedId.data}::uuid AND "publicAccessTokenHash" = ${tokenHash} AND "status" = 'WAITING_PAYMENT' AND "holdExpiresAt" <= ${now}`;
      const row = await tx.appointment.findFirst({ where: { id: parsedId.data, publicAccessTokenHash: tokenHash }, select: viewSelect });
      if (!row) throw new AppointmentError("Запись не найдена.", 404);
      return appointmentView(row, now, Boolean((await tx.salonSettings.findUnique({ where: { id: "salon" }, select: { isDemo: true } }))?.isDemo));
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 });
  } catch (error) { throw safeError(error); }
}
