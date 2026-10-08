import "server-only";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { databaseNow, expireMasterHolds, lockAppointmentMaster } from "./appointment-repository";
import { canFitScheduledInterval, AvailabilityConfigurationError } from "./availability-engine";
import { getDatabase } from "./db";
import { assertVerifiedPaymentEvent, beginTestPaymentSession, createSignedTestEvent, verifyPaymentEvent,
  PaymentEventError, type VerifiedPaymentEvent } from "./payment-adapter";
import { assertTestPaymentEnabled, PaymentConfigurationError } from "./payment-configuration";
import { paymentViewSelect, toPaymentView, type PaymentEventResult, type PaymentView, type TestPaymentAction } from "./payment-types";
import { salonDateString } from "./salon-time";

export class PaymentError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "PaymentError"; }
}
type Options = { database?: PrismaClient };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const requestSchema = z.object({ idempotencyKey: uuid }).strict();
const actionSchema = z.enum(["success", "fail", "cancel", "expire"]);
const appointmentSelect = { id: true, masterId: true, status: true, holdExpiresAt: true, startsAt: true, occupiedUntil: true,
  totalDurationMinutes: true, totalBufferMinutes: true, prepaymentRequiredMinor: true, currency: true } as const satisfies Prisma.AppointmentSelect;
type PaymentAppointment = Prisma.AppointmentGetPayload<{ select: typeof appointmentSelect }>;
const eventPaymentSelect = { ...paymentViewSelect, providerPaymentId: true, appointment: { select: appointmentSelect } } as const;
const paidStatuses = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
function hash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function credentials(id: string, token: string) {
  const parsed = uuid.safeParse(id);
  if (!parsed.success || !tokenSchema.safeParse(token).success) throw new PaymentError("Запись или платёж не найдены.", 404);
  return { id: parsed.data, tokenHash: hash(token) };
}
function codes(error: unknown) {
  const found = new Set<string>(); const seen = new Set<object>();
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return;
    seen.add(value); const record = value as Record<string, unknown>;
    for (const key of ["code", "sqlState", "sqlstate", "originalCode"]) if (typeof record[key] === "string") found.add(record[key]);
    for (const key of ["cause", "meta", "driverAdapterError", "originalError", "error"]) visit(record[key], depth + 1);
  }
  visit(error, 0); return found;
}
function safeError(error: unknown): PaymentError {
  if (error instanceof PaymentError) return error;
  if (error instanceof PaymentEventError || error instanceof PaymentConfigurationError) return new PaymentError(error.message, error.status);
  return new PaymentError("Платёж временно недоступен. Повторите попытку через несколько секунд.", 503);
}
function databaseFor(options: Options) {
  try { return options.database ?? getDatabase(); } catch (error) { throw safeError(error); }
}
async function transaction<T>(database: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await database.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '12s'`;
        return operation(tx);
      }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (error instanceof PaymentError || error instanceof PaymentEventError || error instanceof PaymentConfigurationError) throw safeError(error);
      // Exclusion conflicts also need a fresh snapshot: a paid notification
      // must survive the booking race and become an attention item if occupied.
      const retry = ["P2034", "40001", "40P01", "P2002", "23505", "23P01"].some(code => codes(error).has(code));
      // Independent request aliases can conflict on the same SSI index page.
      // A fresh snapshot and jitter let a burst converge instead of keeping
      // every contender in lockstep until its retry budget is exhausted.
      if (retry && attempt < 7) { await new Promise(resolve => setTimeout(resolve, randomInt(25, 125) + attempt * 20)); continue; }
      throw safeError(error);
    }
  }
  throw new PaymentError("Платёж временно недоступен. Повторите попытку.", 503);
}
async function lockResource(tx: Prisma.TransactionClient, key: string) {
  // Request/event lock first, master's booking lock second; every operation
  // follows this order, including all future admin schedule/payment mutations.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"romeo:payment:" + key}, 0))`;
}
async function assertEnabled(tx: Prisma.TransactionClient) {
  const settings = await tx.salonSettings.findUnique({ where: { id: "salon" }, select: { isDemo: true } });
  assertTestPaymentEnabled(Boolean(settings?.isDemo));
}

/** A browser can request an attempt, never supply its amount or mark it paid. */
export async function createPayment(appointmentId: string, token: string, input: unknown, options: Options = {}): Promise<PaymentView> {
  const auth = credentials(appointmentId, token);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new PaymentError("Начните создание платежа заново.", 400);
  const request = parsed.data;
  return transaction(databaseFor(options), async tx => {
    await lockResource(tx, "request:" + request.idempotencyKey);
    const appointment = await tx.appointment.findFirst({ where: { id: auth.id, publicAccessTokenHash: auth.tokenHash }, select: appointmentSelect });
    if (!appointment) throw new PaymentError("Запись или платёж не найдены.", 404);
    await assertEnabled(tx);
    const replay = await tx.paymentRequest.findUnique({ where: { idempotencyKey: request.idempotencyKey }, select: { payment: { select: paymentViewSelect } } });
    if (replay && replay.payment.appointmentId !== appointment.id) throw new PaymentError("Этот запрос уже использован. Начните создание платежа заново.", 409);
    await lockAppointmentMaster(tx, appointment.masterId);
    const now = await databaseNow(tx);
    await expireMasterHolds(tx, appointment.masterId);
    if (replay) return toPaymentView(await tx.payment.findUniqueOrThrow({ where: { id: replay.payment.id }, select: paymentViewSelect }));
    const current = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id }, select: appointmentSelect });
    if (current.status !== "WAITING_PAYMENT" || !current.holdExpiresAt || current.holdExpiresAt <= now || current.prepaymentRequiredMinor <= 0) {
      throw new PaymentError("Время для оплаты этой брони истекло или предоплата не требуется. Проверьте запись.", 409);
    }
    const paid = await tx.payment.findFirst({ where: { appointmentId: current.id, status: { in: [...paidStatuses] } }, select: { id: true } });
    if (paid) throw new PaymentError("Предоплата уже получена. Проверьте статус записи.", 409);
    const active = await tx.payment.findFirst({ where: { appointmentId: current.id, status: "PENDING" }, select: paymentViewSelect });
    if (active) {
      await tx.paymentRequest.create({ data: { idempotencyKey: request.idempotencyKey, paymentId: active.id, createdAt: now } });
      return toPaymentView(active);
    }
    const session = beginTestPaymentSession();
    const payment = await tx.payment.create({ data: { appointmentId: current.id, provider: session.provider, mode: session.mode,
      providerPaymentId: session.providerPaymentId, idempotencyKey: request.idempotencyKey, amountMinor: current.prepaymentRequiredMinor,
      currency: current.currency, status: "PENDING", expiresAt: current.holdExpiresAt, createdAt: now, updatedAt: now }, select: paymentViewSelect });
    await tx.paymentRequest.create({ data: { idempotencyKey: request.idempotencyKey, paymentId: payment.id, createdAt: now } });
    return toPaymentView(payment);
  });
}

async function readAuthorizedPayment(paymentId: string, token: string, options: Options) {
  const auth = credentials(paymentId, token);
  return transaction(databaseFor(options), async tx => {
    const row = await tx.payment.findFirst({ where: { id: auth.id, appointment: { publicAccessTokenHash: auth.tokenHash } }, select: eventPaymentSelect });
    if (!row) throw new PaymentError("Запись или платёж не найдены.", 404);
    await assertEnabled(tx);
    return row;
  });
}

/** The local demonstration goes through exactly the signed-event verifier. */
export async function simulateTestPayment(paymentId: string, token: string, action: TestPaymentAction, options: Options = {}): Promise<PaymentView> {
  const parsed = actionSchema.safeParse(action);
  if (!parsed.success) throw new PaymentError("Выберите результат тестовой оплаты.", 400);
  const payment = await readAuthorizedPayment(paymentId, token, options);
  if (payment.provider !== "ROMEO_TEST" || payment.mode !== "TEST" || !payment.providerPaymentId) throw new PaymentError("Тестовый платёж недоступен.", 409);
  const statuses = { success: "SUCCEEDED", fail: "FAILED", cancel: "CANCELLED", expire: "EXPIRED" } as const;
  let signed;
  try { signed = createSignedTestEvent({ paymentId: payment.id, appointmentId: payment.appointmentId, providerPaymentId: payment.providerPaymentId,
    amountMinor: payment.amountMinor, currency: payment.currency }, statuses[parsed.data]); }
  catch (error) { throw safeError(error); }
  await processPaymentEvent(signed.rawBody, signed.signature, options);
  const current = await readAuthorizedPayment(paymentId, token, options);
  return toPaymentView({ id: current.id, appointmentId: current.appointmentId, provider: current.provider, mode: current.mode, status: current.status,
    amountMinor: current.amountMinor, refundedAmountMinor: current.refundedAmountMinor, currency: current.currency, createdAt: current.createdAt,
    expiresAt: current.expiresAt, paidAt: current.paidAt, needsAttention: current.needsAttention });
}

async function intervalStillFree(tx: Prisma.TransactionClient, appointment: PaymentAppointment, now: Date): Promise<boolean> {
  if (appointment.startsAt <= now) return false;
  const [settings, master] = await Promise.all([
    tx.salonSettings.findUnique({ where: { id: "salon" }, select: { timezone: true, bookingHorizonDays: true, minimumLeadMinutes: true, slotStepMinutes: true } }),
    tx.master.findUnique({ where: { id: appointment.masterId }, select: { isBookable: true, archivedAt: true } }),
  ]);
  if (!settings || !master?.isBookable || master.archivedAt) return false;
  try {
    const localDate = salonDateString(appointment.startsAt, settings.timezone);
    const [weeklyIntervals, exceptions, occupied] = await Promise.all([
      tx.weeklySchedule.findMany({ where: { masterId: appointment.masterId }, select: { dayOfWeek: true, startMinute: true, endMinute: true } }),
      tx.scheduleException.findMany({ where: { masterId: appointment.masterId, localDate: new Date(localDate + "T00:00:00Z") },
        select: { localDate: true, kind: true, intervals: { select: { kind: true, startMinute: true, endMinute: true } } } }),
      tx.appointment.findMany({ where: { id: { not: appointment.id }, masterId: appointment.masterId, startsAt: { lt: appointment.occupiedUntil }, occupiedUntil: { gt: appointment.startsAt },
        OR: [{ status: "CONFIRMED" }, { status: "WAITING_PAYMENT", holdExpiresAt: { gt: now } }] }, select: { startsAt: true, occupiedUntil: true } }),
    ]);
    return canFitScheduledInterval({ timezone: settings.timezone, policy: settings, durationMinutes: appointment.totalDurationMinutes, bufferMinutes: appointment.totalBufferMinutes,
      weeklyIntervals, exceptionRows: exceptions.map(row => ({ date: row.localDate.toISOString().slice(0, 10), kind: row.kind, intervals: row.intervals })),
      occupied: occupied.map(row => ({ startAt: row.startsAt, endAt: row.occupiedUntil })) }, appointment.startsAt, appointment.occupiedUntil);
  } catch (error) {
    // Invalid schedule configuration must never lose a verified payment. Keep
    // the financial fact and refer the unresolved reservation to the salon.
    if (error instanceof AvailabilityConfigurationError || error instanceof RangeError) return false;
    throw error;
  }
}

export async function processPaymentEvent(rawBody: string, signature: string, options: Options = {}): Promise<PaymentEventResult> {
  let verified;
  try { verified = verifyPaymentEvent(rawBody, signature); } catch (error) { throw safeError(error); }
  return applyVerifiedPaymentEvent(verified, options);
}

/** Accepts only the adapter's runtime proof, never a browser-supplied status. */
export async function applyVerifiedPaymentEvent(event: VerifiedPaymentEvent, options: Options = {}): Promise<PaymentEventResult> {
  try { assertVerifiedPaymentEvent(event); } catch (error) { throw safeError(error); }
  return transaction(databaseFor(options), async tx => {
    await lockResource(tx, "event:ROMEO_TEST:TEST:" + event.eventId);
    const previous = await tx.paymentEvent.findUnique({ where: { provider_mode_eventId: { provider: "ROMEO_TEST", mode: "TEST", eventId: event.eventId } },
      select: { payloadFingerprint: true } });
    await assertEnabled(tx);
    if (previous) {
      if (previous.payloadFingerprint !== event.payloadHash) throw new PaymentError("Платёжное событие уже получено с другими данными.", 409);
      return { accepted: true, duplicate: true };
    }
    const found = await tx.payment.findUnique({ where: { id: event.paymentId }, select: eventPaymentSelect });
    if (!found || found.provider !== "ROMEO_TEST" || found.mode !== "TEST" || found.appointmentId !== event.appointmentId
      || found.providerPaymentId !== event.providerPaymentId || found.amountMinor !== event.amountMinor || found.currency !== event.currency) {
      throw new PaymentError("Платёжное событие не соответствует платежу.", 400);
    }
    await lockAppointmentMaster(tx, found.appointment.masterId);
    const now = await databaseNow(tx);
    await expireMasterHolds(tx, found.appointment.masterId);
    // The expiry worker locks payments before appointments too. Maintain the
    // same row order so deadline-edge success is serialized and retried safely.
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, select: eventPaymentSelect });
    await tx.paymentEvent.create({ data: { paymentId: payment.id, provider: payment.provider, mode: payment.mode, eventId: event.eventId,
      payloadFingerprint: event.payloadHash, status: event.status, issuedAt: new Date(event.issuedAt), receivedAt: now } });
    if (paidStatuses.includes(payment.status as typeof paidStatuses[number])) return { accepted: true, duplicate: false };
    if (event.status !== "SUCCEEDED") {
      await tx.payment.update({ where: { id: payment.id }, data: { status: event.status, updatedAt: now } });
      return { accepted: true, duplicate: false };
    }
    const otherPaid = await tx.payment.findFirst({ where: { appointmentId: payment.appointmentId, id: { not: payment.id }, status: { in: [...paidStatuses] } }, select: { id: true } });
    let reason: string | null = otherPaid ? "DUPLICATE_PREPAYMENT" : null;
    const appointment = payment.appointment;
    if (appointment.status !== "CONFIRMED") {
      const eligible = ["WAITING_PAYMENT", "EXPIRED"].includes(appointment.status);
      if (eligible && await intervalStillFree(tx, appointment, now)) {
        await tx.appointment.update({ where: { id: appointment.id }, data: { status: "CONFIRMED", confirmedAt: now, updatedAt: now } });
      } else reason = reason ?? "PAID_RESERVATION_UNAVAILABLE";
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED", paidAt: now, updatedAt: now, needsAttention: Boolean(reason), attentionReason: reason } });
    return { accepted: true, duplicate: false };
  });
}
