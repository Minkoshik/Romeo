import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getPaymentConfiguration, PaymentConfigurationError } from "./payment-configuration";

const MAX_EVENT_BYTES = 16 * 1024;
const REPLAY_WINDOW_MS = 5 * 60_000;
const verifiedEventBrand = Symbol("verified-payment-event");
const verifiedEvents = new WeakSet<object>();
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const currency = z.string().regex(/^[A-Z]{3}$/);
const paymentContextSchema = z.object({
  paymentId: uuid, appointmentId: uuid, providerPaymentId: uuid,
  amountMinor: z.number().int().positive().max(2_147_483_647), currency,
}).strict();
const eventSchema = paymentContextSchema.extend({
  eventId: uuid,
  issuedAt: z.iso.datetime({ precision: 3 }),
  status: z.enum(["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]),
}).strict();

export type TestPaymentContext = z.output<typeof paymentContextSchema>;
export type TestPaymentStatus = z.output<typeof eventSchema>["status"];
export type TestPaymentSession = { provider: "ROMEO_TEST"; mode: "TEST"; providerPaymentId: string; sessionId: string };
export type SignedTestPaymentEvent = { rawBody: string; signature: string };
export type VerifiedPaymentEvent = z.output<typeof eventSchema> & {
  readonly payloadHash: string;
  readonly [verifiedEventBrand]: true;
};

export class PaymentEventError extends Error {
  constructor(message = "Некорректное платёжное событие.", public readonly status: 400 | 401 = 400) {
    super(message); this.name = "PaymentEventError";
  }
}

/** Shared adapter contract; a real provider must supply its own verification. */
export interface PaymentAdapter {
  readonly provider: "ROMEO_TEST";
  readonly mode: "TEST";
  beginSession(): TestPaymentSession;
  signTestEvent(context: TestPaymentContext, status: TestPaymentStatus, options?: { eventId?: string; now?: Date }): SignedTestPaymentEvent;
  verifyEvent(rawBody: string | Uint8Array, signature: string, now?: Date): VerifiedPaymentEvent;
}

function configuration() {
  const value = getPaymentConfiguration();
  if (!value) throw new PaymentConfigurationError();
  return value;
}

export function beginTestPaymentSession(): TestPaymentSession {
  const config = configuration();
  return { provider: config.provider, mode: config.mode, providerPaymentId: randomUUID(), sessionId: randomUUID() };
}

/** Backend must bind this context to an owned Payment row before simulating. */
export function createSignedTestEvent(context: TestPaymentContext, status: TestPaymentStatus,
  options: { eventId?: string; now?: Date } = {}): SignedTestPaymentEvent {
  const config = configuration();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new PaymentEventError();
  const parsed = eventSchema.safeParse({ ...context, eventId: options.eventId ?? randomUUID(), issuedAt: now.toISOString(), status });
  if (!parsed.success) throw new PaymentEventError();
  const rawBody = JSON.stringify(parsed.data);
  const signature = createHmac("sha256", config.webhookSecret).update(rawBody, "utf8").digest("hex");
  return { rawBody, signature };
}

/** Verify exact received bytes first. Browser success flags are never evidence. */
export function verifyPaymentEvent(rawBody: string | Uint8Array, signature: string, now: Date = new Date()): VerifiedPaymentEvent {
  const config = configuration();
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) throw new PaymentEventError();
  const bytes = Buffer.from(rawBody);
  if (bytes.byteLength > MAX_EVENT_BYTES || bytes.byteLength === 0) throw new PaymentEventError();
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) throw new PaymentEventError("Подлинность платёжного события не подтверждена.", 401);
  const expected = createHmac("sha256", config.webhookSecret).update(bytes).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new PaymentEventError("Подлинность платёжного события не подтверждена.", 401);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PaymentEventError(); }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success || !Number.isFinite(now.getTime())) throw new PaymentEventError();
  if (Math.abs(Date.parse(parsed.data.issuedAt) - now.getTime()) > REPLAY_WINDOW_MS) {
    throw new PaymentEventError("Срок проверки платёжного события истёк.", 401);
  }
  const payloadHash = createHash("sha256").update(JSON.stringify(parsed.data), "utf8").digest("hex");
  const verified = Object.freeze({ ...parsed.data, payloadHash, [verifiedEventBrand]: true as const });
  verifiedEvents.add(verified);
  return verified;
}

/** Runtime proof prevents a structural cast or deserialized JSON bypass. */
export function assertVerifiedPaymentEvent(value: unknown): asserts value is VerifiedPaymentEvent {
  if (!value || typeof value !== "object" || !verifiedEvents.has(value) || (value as Partial<VerifiedPaymentEvent>)[verifiedEventBrand] !== true) {
    throw new PaymentEventError("Подлинность платёжного события не подтверждена.", 401);
  }
}

export const testPaymentAdapter: PaymentAdapter = Object.freeze({
  provider: "ROMEO_TEST", mode: "TEST",
  beginSession: beginTestPaymentSession, signTestEvent: createSignedTestEvent, verifyEvent: verifyPaymentEvent,
});
