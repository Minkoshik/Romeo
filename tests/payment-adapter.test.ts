import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { assertVerifiedPaymentEvent, beginTestPaymentSession, createSignedTestEvent, PaymentEventError, testPaymentAdapter, verifyPaymentEvent, type TestPaymentContext } from "../src/lib/payment-adapter";
import { assertTestPaymentEnabled, getPaymentConfiguration, PaymentConfigurationError, testPaymentAvailability } from "../src/lib/payment-configuration";

const secret = "0123456789abcdefghijklmnopqrstuv";
const now = new Date("2026-10-07T10:00:00.000Z");
const context: TestPaymentContext = { paymentId: randomUUID(), appointmentId: randomUUID(), providerPaymentId: randomUUID(), amountMinor: 55000, currency: "RUB" };
const testEnvironment: Record<string, string | undefined> = process.env;

async function configured(run: () => unknown | Promise<unknown>) {
  const keys = ["APP_ENV", "PAYMENT_MODE", "PAYMENT_WEBHOOK_SECRET", "NODE_ENV"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.APP_ENV = "demo"; process.env.PAYMENT_MODE = "TEST"; process.env.PAYMENT_WEBHOOK_SECRET = secret;
    await run();
  } finally {
    for (const key of keys) if (saved[key] === undefined) delete testEnvironment[key]; else testEnvironment[key] = saved[key];
  }
}
const sign = (body: string | Uint8Array) => createHmac("sha256", secret).update(body).digest("hex");
const event = () => createSignedTestEvent(context, "SUCCEEDED", { now });

test("test configuration requires explicit demo environment, TEST mode and a strong private secret", async () => {
  await configured(() => {
    assert.equal(getPaymentConfiguration()?.mode, "TEST");
    for (const appEnv of [undefined, "", "production", "staging", "DEMO", "off"]) {
      assert.equal(getPaymentConfiguration({ APP_ENV: appEnv, PAYMENT_MODE: "TEST", PAYMENT_WEBHOOK_SECRET: secret }), null);
    }
    for (const mode of [undefined, "", "LIVE", "test", "DISABLED"]) {
      assert.equal(getPaymentConfiguration({ APP_ENV: "demo", PAYMENT_MODE: mode, PAYMENT_WEBHOOK_SECRET: secret }), null);
    }
    for (const weak of [undefined, "", "short", secret.slice(1), "a".repeat(64), "change-me-secret-0123456789abcdefghijklmnop", "demo_only_secret_0123456789abcdefghijklmnop", secret + "\n"]) {
      assert.equal(getPaymentConfiguration({ APP_ENV: "demo", PAYMENT_MODE: "TEST", PAYMENT_WEBHOOK_SECRET: weak }), null);
    }
    testEnvironment.NODE_ENV = "production";
    assert.equal(assertTestPaymentEnabled(true).mode, "TEST"); // Local production build deliberately opts into demo.
    assert.throws(() => assertTestPaymentEnabled(false), PaymentConfigurationError);
    assert.equal(testPaymentAvailability(false).mode, "DISABLED");
    assert.deepEqual(testPaymentAvailability(true), { mode: "TEST" });
    assert.equal(JSON.stringify(testPaymentAvailability(true)).includes(secret), false);
    process.env.APP_ENV = "production";
    assert.equal(testPaymentAvailability(true).mode, "DISABLED");
    assert.throws(() => beginTestPaymentSession(), PaymentConfigurationError);
  });
});

test("provider and session IDs are generated independently on the server", async () => {
  await configured(() => {
    const first = beginTestPaymentSession(); const second = testPaymentAdapter.beginSession();
    assert.equal(first.provider, "ROMEO_TEST"); assert.equal(first.mode, "TEST");
    for (const id of [first.providerPaymentId, first.sessionId, second.providerPaymentId, second.sessionId]) assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(new Set([first.providerPaymentId, first.sessionId, second.providerPaymentId, second.sessionId]).size, 4);
    assert.equal(JSON.stringify(first).includes(secret), false);
  });
});

test("known server actions produce signed, immutable and runtime-branded events", async () => {
  await configured(() => {
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] as const) {
      const signed = createSignedTestEvent(context, status, { now });
      assert.match(signed.signature, /^[a-f0-9]{64}$/);
      const verified = verifyPaymentEvent(signed.rawBody, signed.signature, now);
      assertVerifiedPaymentEvent(verified);
      assert.equal(verified.status, status); assert.equal(verified.paymentId, context.paymentId);
      assert.equal(verified.appointmentId, context.appointmentId); assert.equal(verified.providerPaymentId, context.providerPaymentId);
      assert.equal(verified.amountMinor, 55000); assert.equal(verified.currency, "RUB");
      assert.equal(Object.isFrozen(verified), true); assert.match(verified.payloadHash, /^[a-f0-9]{64}$/);
      assert.throws(() => assertVerifiedPaymentEvent(JSON.parse(JSON.stringify(verified))), PaymentEventError);
      assert.throws(() => assertVerifiedPaymentEvent({ ...verified, amountMinor: 1 }), PaymentEventError);
    }
    assert.throws(() => assertVerifiedPaymentEvent({ ...JSON.parse(event().rawBody), payloadHash: "a".repeat(64) }), PaymentEventError);
  });
});

test("signature authenticates exact body bytes, not parsed browser status", async () => {
  await configured(() => {
    const signed = event();
    assert.throws(() => verifyPaymentEvent(signed.rawBody + " ", signed.signature, now), PaymentEventError);
    assert.throws(() => verifyPaymentEvent(signed.rawBody.replace("55000", "55001"), signed.signature, now), PaymentEventError);
    for (const signature of ["", "0".repeat(63), "z".repeat(64), "0".repeat(64), "sha256=" + signed.signature]) {
      assert.throws(() => verifyPaymentEvent(signed.rawBody, signature, now), PaymentEventError);
    }
    assert.equal(verifyPaymentEvent(Buffer.from(signed.rawBody), signed.signature.toUpperCase(), now).status, "SUCCEEDED");
  });
});

test("timestamp validation bounds both stale and future signed events", async () => {
  await configured(() => {
    const signed = event();
    assert.equal(verifyPaymentEvent(signed.rawBody, signed.signature, new Date(now.getTime() + 300000)).status, "SUCCEEDED");
    assert.equal(verifyPaymentEvent(signed.rawBody, signed.signature, new Date(now.getTime() - 300000)).status, "SUCCEEDED");
    assert.throws(() => verifyPaymentEvent(signed.rawBody, signed.signature, new Date(now.getTime() + 300001)), PaymentEventError);
    assert.throws(() => verifyPaymentEvent(signed.rawBody, signed.signature, new Date(now.getTime() - 300001)), PaymentEventError);
    assert.throws(() => verifyPaymentEvent(signed.rawBody, signed.signature, new Date(NaN)), PaymentEventError);
  });
});

test("even authenticated payloads require exact identifiers, amount, currency, status and fields", async () => {
  await configured(() => {
    const valid = JSON.parse(event().rawBody);
    const variants = [
      { ...valid, amountMinor: 0 }, { ...valid, amountMinor: -1 }, { ...valid, amountMinor: 1.5 }, { ...valid, amountMinor: "55000" },
      { ...valid, amountMinor: 2147483648 }, { ...valid, currency: "rub" }, { ...valid, currency: "RUBX" },
      { ...valid, paymentId: "fake" }, { ...valid, appointmentId: "fake" }, { ...valid, providerPaymentId: "fake" },
      { ...valid, eventId: "fake" }, { ...valid, issuedAt: "2026-10-07T10:00:00" }, { ...valid, issuedAt: "2026-02-30T10:00:00.000Z" },
      { ...valid, status: "success" }, { ...valid, provider: "FOREIGN" }, { ...valid, paid: true }, { ...valid, secret },
    ];
    for (const payload of variants) {
      const rawBody = JSON.stringify(payload);
      assert.throws(() => verifyPaymentEvent(rawBody, sign(rawBody), now), PaymentEventError);
    }
    for (const rawBody of ["{}", "[]", "null", "broken", JSON.stringify(valid).padEnd(16385, " ")]) {
      assert.throws(() => verifyPaymentEvent(rawBody, sign(rawBody), now), PaymentEventError);
    }
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe]);
    assert.throws(() => verifyPaymentEvent(invalidUtf8, sign(invalidUtf8), now), PaymentEventError);
  });
});

test("canonical event hash is stable across JSON formatting for DB receipt deduplication", async () => {
  await configured(() => {
    const signed = event();
    const first = verifyPaymentEvent(signed.rawBody, signed.signature, now);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(signed.rawBody)).reverse()), null, 2);
    const second = verifyPaymentEvent(reordered, sign(reordered), now);
    assert.equal(first.payloadHash, second.payloadHash);
    const changed = JSON.stringify({ ...JSON.parse(signed.rawBody), status: "FAILED" });
    assert.notEqual(first.payloadHash, verifyPaymentEvent(changed, sign(changed), now).payloadHash);
  });
});

test("signing validates the server-bound context and disabled configuration blocks every adapter operation", async () => {
  await configured(() => {
    assert.throws(() => createSignedTestEvent({ ...context, amountMinor: 0 }, "SUCCEEDED", { now }), PaymentEventError);
    assert.throws(() => createSignedTestEvent(context, "SUCCEEDED", { now: new Date(NaN) }), PaymentEventError);
    const signed = event();
    process.env.PAYMENT_MODE = "LIVE";
    assert.throws(() => createSignedTestEvent(context, "SUCCEEDED", { now }), PaymentConfigurationError);
    assert.throws(() => verifyPaymentEvent(signed.rawBody, signed.signature, now), PaymentConfigurationError);
    assert.throws(() => beginTestPaymentSession(), PaymentConfigurationError);
    assert.equal(testPaymentAvailability(true).mode, "DISABLED");
  });
});
