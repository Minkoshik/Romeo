import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { POST as create } from "../src/app/api/appointments/[id]/payments/route";
import { POST as simulate } from "../src/app/api/payments/test/[id]/simulate/route";
import { POST as callback } from "../src/app/api/payments/events/test/route";
import { createSignedTestEvent } from "../src/lib/payment-adapter";

const origin = "http://127.0.0.1:3000";
const id = "550e8400-e29b-41d4-a716-446655440000";
const token = "A".repeat(43);
const createUrl = origin + "/api/appointments/" + id + "/payments";
const simulateUrl = origin + "/api/payments/test/" + id + "/simulate";
const callbackUrl = origin + "/api/payments/events/test";
const context = () => ({ params: Promise.resolve({ id }) });
const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
async function publicError(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.error, /[А-Яа-яЁё]/);
  for (const key of ["id", "paymentId", "appointmentId", "accepted", "status", "stack", "signature", "webhookSecret", "payloadFingerprint"]) assert.equal(key in body, false);
  assert.equal(JSON.stringify(body).includes("DATABASE_URL"), false);
  return body;
}
async function configured(run: (secret: string) => Promise<void>) {
  const keys = ["APP_ENV", "PAYMENT_MODE", "PAYMENT_WEBHOOK_SECRET"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const secret = randomBytes(32).toString("hex");
  try {
    process.env.APP_ENV = "demo"; process.env.PAYMENT_MODE = "TEST"; process.env.PAYMENT_WEBHOOK_SECRET = secret;
    await run(secret);
  } finally {
    for (const key of keys) if (saved[key] === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = saved[key];
  }
}

test("Payment creation and simulation reject foreign or malformed browser origins", async () => {
  for (const value of ["https://foreign.example", "http://127.0.0.1:4000", "null", origin + "/path", "invalid-origin"]) {
    for (const [url, handler] of [[createUrl, create], [simulateUrl, simulate]] as const) {
      await publicError(await handler(new Request(url, { method: "POST", headers: { ...auth, origin: value }, body: "{}" }), context()), 403);
    }
  }
});

test("Payment APIs accept ownership only in the Bearer header", async () => {
  for (const authorization of [undefined, "", "Bearer short", "Basic " + token, "Bearer " + token + " extra"]) {
    for (const [url, handler] of [[createUrl, create], [simulateUrl, simulate]] as const) {
      const headers: HeadersInit = { "content-type": "application/json" };
      if (authorization !== undefined) headers.authorization = authorization;
      await publicError(await handler(new Request(url + "?accessToken=" + token, { method: "POST", headers, body: "{}" }), context()), 404);
    }
  }
});

test("Payment APIs reject client amounts, paid flags, refunds and malformed JSON before database access", async () => {
  for (const input of [null, [], {}, { idempotencyKey: "invalid" },
    { idempotencyKey: randomUUID(), amountMinor: 1 }, { idempotencyKey: randomUUID(), currency: "USD" },
    { idempotencyKey: randomUUID(), status: "SUCCEEDED" }, { idempotencyKey: randomUUID(), paidMinor: 55000 }]) {
    await publicError(await create(new Request(createUrl, { method: "POST", headers: auth, body: JSON.stringify(input) }), context()), 400);
  }
  for (const input of [{}, { action: "refund" }, { action: "SUCCEEDED" }, { action: "success", amountMinor: 1 }, { action: "success", paid: true }]) {
    await publicError(await simulate(new Request(simulateUrl, { method: "POST", headers: auth, body: JSON.stringify(input) }), context()), 400);
  }
  for (const [url, handler] of [[createUrl, create], [simulateUrl, simulate]] as const) {
    await publicError(await handler(new Request(url, { method: "POST", headers: auth, body: "{" }), context()), 400);
    await publicError(await handler(new Request(url, { method: "POST", headers: auth, body: new Uint8Array([0xc3, 0x28]) }), context()), 400);
    await publicError(await handler(new Request(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain" }, body: "{}" }), context()), 415);
  }
});

test("Payment body limits count streamed UTF-8 bytes despite a forged Content-Length", async () => {
  const body = JSON.stringify({ padding: "ж".repeat(9000) });
  assert.ok(body.length < 16384 && Buffer.byteLength(body, "utf8") > 16384);
  await publicError(await create(new Request(createUrl, { method: "POST", headers: { ...auth, "content-length": "1" }, body }), context()), 413);
  await publicError(await simulate(new Request(simulateUrl, { method: "POST", headers: { ...auth, "content-length": "16385" }, body: "{}" }), context()), 413);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(" ".repeat(8000)));
    controller.enqueue(new TextEncoder().encode(" ".repeat(9000)));
    controller.close();
  } });
  await publicError(await callback(new Request(callbackUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: stream, duplex: "half" } as RequestInit & { duplex: "half" })), 413);
});

test("Callback verifies HMAC and strict event fields before any database write", async () => {
  await configured(async secret => {
    const signed = createSignedTestEvent({ paymentId: randomUUID(), appointmentId: randomUUID(),
      providerPaymentId: randomUUID(), amountMinor: 55000, currency: "RUB" }, "SUCCEEDED");
    for (const signature of ["", "bad", "0".repeat(64)]) {
      await publicError(await callback(new Request(callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-romeo-signature": signature },
        body: signed.rawBody })), 401);
    }
    await publicError(await callback(new Request(callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-romeo-signature": signed.signature },
      body: signed.rawBody + " " })), 401);
    const invalidPayload = JSON.stringify({ ...JSON.parse(signed.rawBody), amountMinor: 0, status: "REFUNDED" });
    const signature = createHmac("sha256", secret).update(invalidPayload, "utf8").digest("hex");
    await publicError(await callback(new Request(callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-romeo-signature": signature },
      body: invalidPayload })), 400);
    process.env.APP_ENV = "production";
    const error = await publicError(await callback(new Request(callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-romeo-signature": signed.signature },
      body: signed.rawBody })), 503);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(signed.signature), false);
  });
});
