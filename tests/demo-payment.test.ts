import assert from "node:assert/strict";
import test from "node:test";
import { createDemoPaymentSession, demoPaymentSecondsRemaining, expireDemoPayment, resolveDemoPayment, retryDemoPayment } from "../src/lib/demo-payment";

test("payment simulation exposes no real payment proof or booking identifier", () => {
  const session = createDemoPaymentSession(10, 1000);
  const completed = resolveDemoPayment(session, "success", 2000);
  assert.equal(completed.mode, "DEMO_SIMULATION");
  assert.equal(completed.status, "success");
  assert.deepEqual(Object.keys(completed).sort(), ["attempts", "expiresAt", "mode", "status"]);
  assert.equal(session.status, "pending");
  assert.deepEqual(resolveDemoPayment(completed, "error", 3000), completed);
});

test("errors and cancellations can retry only within the original countdown", () => {
  const session = createDemoPaymentSession(10, 1000);
  for (const outcome of ["error", "cancel"] as const) {
    const failed = resolveDemoPayment(session, outcome, 2000);
    const retried = retryDemoPayment(failed, 3000);
    assert.equal(retried.status, "pending");
    assert.equal(retried.expiresAt, session.expiresAt);
    assert.equal(retried.attempts, 1);
    assert.equal(resolveDemoPayment(retried, "success", session.expiresAt).status, "expired");
    assert.equal(retryDemoPayment(failed, session.expiresAt).status, "expired");
  }
});

test("expiration is terminal and checked independently of the visual countdown", () => {
  const session = createDemoPaymentSession(1, 0);
  assert.equal(demoPaymentSecondsRemaining(session, 1500), 59);
  assert.equal(demoPaymentSecondsRemaining(session, 60_000), 0);
  assert.equal(expireDemoPayment(session, 60_000).status, "expired");
  const expired = resolveDemoPayment(session, "expired", 1000);
  assert.equal(demoPaymentSecondsRemaining(expired, 1000), 0);
  assert.equal(retryDemoPayment(expired, 2000).status, "expired");
  assert.equal(resolveDemoPayment(expired, "success", 3000).status, "expired");
});
