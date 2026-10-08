import assert from "node:assert/strict";
import test from "node:test";
import { createAppointmentExpiryWorker, startAppointmentExpiryWorker, stopAppointmentExpiryWorker, type AppointmentExpiryScheduler } from "../src/lib/appointment-expiry-worker";
import { register } from "../src/instrumentation";

function scheduler() {
  let callback: (() => void) | undefined;
  let interval = 0;
  let created = 0;
  let cleared = 0;
  let unref = 0;
  const handle = { unref() { unref++; } };
  const api: AppointmentExpiryScheduler = {
    setInterval(fn, ms) { callback = fn; interval = ms; created++; return handle; },
    clearInterval(value) { assert.equal(value, handle); callback = undefined; cleared++; },
  };
  return { api, fire() { callback?.(); }, get interval() { return interval; }, get created() { return created; }, get cleared() { return cleared; }, get unref() { return unref; } };
}
const quiet = { info() {}, warn() {} };

test("expiry starts immediately and schedules an unref'ed 30-second timer", async () => {
  const timers = scheduler();
  let calls = 0;
  const worker = createAppointmentExpiryWorker({ scheduler: timers.api, expire: async () => { calls++; return 0; }, logger: quiet });
  try {
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(timers.interval, 30_000);
    assert.equal(timers.unref, 1);
    timers.fire();
    await worker.tick();
    assert.equal(calls, 2);
  } finally { await worker.stop(); }
  assert.equal(timers.cleared, 1);
});

test("overlapping ticks share the in-flight operation and shutdown waits for it", async () => {
  const timers = scheduler();
  let release: ((count: number) => void) | undefined;
  let calls = 0;
  const worker = createAppointmentExpiryWorker({ scheduler: timers.api, expire: () => { calls++; return new Promise(resolve => { release = resolve; }); }, logger: quiet });
  await Promise.resolve();
  const first = worker.tick();
  timers.fire();
  const second = worker.tick();
  assert.equal(first, second);
  assert.equal(calls, 1);
  let ended = false;
  const stop = worker.stop().then(() => { ended = true; });
  await Promise.resolve();
  assert.equal(worker.stopped, true);
  assert.equal(ended, false);
  assert.equal(timers.cleared, 1);
  await worker.tick();
  assert.equal(calls, 1);
  release!(1);
  await stop;
  assert.equal(ended, true);
});

test("database failure retries and recovers without disclosing credentials or customer data", async () => {
  const timers = scheduler();
  const messages: string[] = [];
  let calls = 0;
  const worker = createAppointmentExpiryWorker({ scheduler: timers.api, intervalMs: 7, expire: async () => {
    calls++;
    if (calls < 3) throw new Error("DATABASE_URL=postgres://user:secret@host; customer=Иван; phone=+79990001122");
    return 2;
  }, logger: { info: message => messages.push(String(message)), warn: message => messages.push(String(message)) } });
  try {
    await worker.tick();
    timers.fire(); await worker.tick();
    assert.equal(calls, 2);
    assert.equal(messages.length, 1); // Stable outages do not flood the log.
    timers.fire(); await worker.tick();
    assert.equal(calls, 3);
    assert.equal(messages.length, 3);
    assert.match(messages[1], /восстановлена/);
    assert.match(messages[2], /2/);
    assert.equal(messages.some(message => /secret|Иван|79990001122|DATABASE_URL/.test(message)), false);
    assert.equal(timers.interval, 7);
  } finally { await worker.stop(); }
});

test("synchronously throwing operations and faulty logging still allow the next tick", async () => {
  const timers = scheduler();
  let calls = 0;
  const worker = createAppointmentExpiryWorker({ scheduler: timers.api, expire: () => { calls++; throw new Error("sensitive"); }, logger: { info() { throw new Error("logger"); }, warn() { throw new Error("logger"); } } });
  try {
    await worker.tick();
    timers.fire(); await worker.tick();
    assert.equal(calls, 2);
  } finally { await worker.stop(); }
});

test("HMR singleton starts one timer and can restart after stopping", async () => {
  await stopAppointmentExpiryWorker();
  const timers = scheduler();
  let calls = 0;
  const options = { scheduler: timers.api, expire: async () => { calls++; return 0; }, logger: quiet };
  try {
    const first = startAppointmentExpiryWorker(options);
    const second = startAppointmentExpiryWorker(options);
    assert.equal(first, second);
    assert.equal(timers.created, 1);
    await first.tick();
    assert.equal(calls, 1);
    await stopAppointmentExpiryWorker();
    assert.equal(first.stopped, true);
    const restarted = startAppointmentExpiryWorker(options);
    assert.notEqual(first, restarted);
    await restarted.tick();
    assert.equal(timers.created, 2);
    assert.equal(calls, 2);
  } finally { await stopAppointmentExpiryWorker(); }
});

test("standalone mode keeps its timer referenced until graceful stop", async () => {
  const timers = scheduler();
  const worker = createAppointmentExpiryWorker({ scheduler: timers.api, expire: async () => 0, logger: quiet, keepAlive: true });
  await worker.tick();
  assert.equal(timers.unref, 0);
  await worker.stop();
  assert.equal(timers.cleared, 1);
});

test("instrumentation skips production builds and unsupported runtimes", async () => {
  const runtime = process.env.NEXT_RUNTIME;
  const phase = process.env.NEXT_PHASE;
  try {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";
    await register();
    process.env.NEXT_PHASE = "phase-production-server";
    process.env.NEXT_RUNTIME = "edge";
    await register();
    assert.equal((globalThis as typeof globalThis & { romeoAppointmentExpiryWorker?: unknown }).romeoAppointmentExpiryWorker, undefined);
  } finally {
    if (runtime === undefined) delete process.env.NEXT_RUNTIME; else process.env.NEXT_RUNTIME = runtime;
    if (phase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = phase;
  }
});
