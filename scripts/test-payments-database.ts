import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { demoId, seedDemoCatalog, SeedConfigurationError } from "../prisma/seed";
import { createAppointment, expireAppointmentHolds, getAppointment, AppointmentError } from "../src/lib/appointment-repository";
import { createPayment, processPaymentEvent, simulateTestPayment, PaymentError } from "../src/lib/payment-repository";
import { createSignedTestEvent, type TestPaymentStatus, type SignedTestPaymentEvent } from "../src/lib/payment-adapter";
import { loadDatabaseAvailability } from "../src/lib/availability-repository";
import { getSalon } from "../src/lib/salon";
import { addCalendarDays, salonDateString } from "../src/lib/salon-time";
import type { PaymentView } from "../src/lib/payment-types";

// Migrations, fixtures, payments and callbacks write only to this random schema.
// No production data, public objects or pre-existing schemas are modified.
const schemaName = "qa_romeo_payments_" + randomUUID().replaceAll("-", "");
const safeSchema = /^qa_romeo_payments_[a-f0-9]{32}$/;
const qaSecret = randomBytes(32).toString("hex");
const environmentKeys = ["APP_ENV", "PAYMENT_MODE", "PAYMENT_WEBHOOK_SECRET"] as const;
let checks = 0;
let currentCheck = "Подготовка собственной тестовой схемы";
async function check(label: string, run: () => Promise<void>) {
  currentCheck = label; await run(); checks++; console.info("✓ " + label);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SeedConfigurationError("Для проверки платежей задайте DATABASE_URL.");
  if (!safeSchema.test(schemaName) || process.env.NODE_ENV === "production") throw new SeedConfigurationError("Проверка разрешена только в собственной схеме вне production.");
  const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const enableTest = () => { process.env.APP_ENV = "demo"; process.env.PAYMENT_MODE = "TEST"; process.env.PAYMENT_WEBHOOK_SECRET = qaSecret; };
  enableTest();
  const sql = new Client({ connectionString, connectionTimeoutMillis: 5000, options: "-c timezone=UTC -c search_path=" + schemaName + ",public" });
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6, connectionTimeoutMillis: 5000,
    options: "-c timezone=UTC -c search_path=" + schemaName + ",public" }, { schema: schemaName }) });
  let connected = false;
  let created = false;
  const defaults = getSalon();
  const salon = { ...defaults, timezone: "Europe/Moscow", policy: { ...defaults.policy,
    bookingHorizonDays: 30, minimumLeadMinutes: 0, slotStepMinutes: 30, bufferMinutes: 15,
    holdDurationMinutes: 10, prepaymentMode: "PERCENTAGE" as const, prepaymentPercentage: 25 } };
  let date = addCalendarDays(salonDateString(new Date(), salon.timezone), 1);
  while (new Date(date + "T12:00:00Z").getUTCDay() === 0) date = addCalendarDays(date, 1);
  const alexId = demoId("master", "alex");
  const markId = demoId("master", "mark");
  const menId = demoId("variant", "mens-cut-standard");
  let phoneCounter = 0;
  const request = (overrides: Record<string, unknown> = {}) => ({
    variantIds: [menId], masterId: alexId, date, time: "10:00", consent: true,
    contacts: { name: "Тестовый плательщик", phone: "+7916" + String(2000000 + phoneCounter++),
      email: "qa-payment@example.invalid", comment: "Только изолированная проверка платежей" },
    idempotencyKey: randomUUID(), accessToken: randomBytes(32).toString("base64url"), ...overrides,
  });
  const book = async (overrides: Record<string, unknown> = {}) => {
    const input = request(overrides);
    return { input, token: input.accessToken, view: await createAppointment(input, { database }) };
  };
  type Booking = Awaited<ReturnType<typeof book>>;
  const pay = (booking: Booking, key = randomUUID(), extra: Record<string, unknown> = {}) =>
    createPayment(booking.view.id, booking.token, { idempotencyKey: key, ...extra }, { database });
  const read = (booking: Booking) => getAppointment(booking.view.id, booking.token, { database });
  const action = (payment: PaymentView, booking: Booking, outcome: "success" | "fail" | "cancel" | "expire") =>
    simulateTestPayment(payment.id, booking.token, outcome, { database });
  const event = async (payment: PaymentView, status: TestPaymentStatus, options: { eventId?: string; now?: Date } = {}) => {
    const row = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    assert.ok(row.providerPaymentId);
    return createSignedTestEvent({ paymentId: row.id, appointmentId: row.appointmentId,
      providerPaymentId: row.providerPaymentId, amountMinor: row.amountMinor, currency: row.currency }, status, options);
  };
  const deliver = (signed: SignedTestPaymentEvent) => processPaymentEvent(signed.rawBody, signed.signature, { database });
  const resign = (payload: Record<string, unknown>) => {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: createHmac("sha256", qaSecret).update(rawBody, "utf8").digest("hex") };
  };
  const counts = () => Promise.all([database.payment.count(), database.paymentEvent.count()]);
  const paymentError = (statuses: number[]) => (error: unknown) => error instanceof PaymentError && statuses.includes(error.status);
  const empty = async () => {
    enableTest();
    await database.$transaction([database.paymentRequest.deleteMany(), database.paymentEvent.deleteMany(), database.payment.deleteMany(),
      database.appointmentItem.deleteMany(), database.appointment.deleteMany(), database.customer.deleteMany(), database.scheduleException.deleteMany()]);
    await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: true, currency: "RUB", minimumLeadMinutes: 0,
      prepaymentMode: "PERCENTAGE", prepaymentPercentageBps: 2500, prepaymentFixedMinor: null } });
  };
  const expireFixture = async (booking: Booking) => {
    const native = await sql.query<{ epoch_ms: number }>("SELECT (extract(epoch FROM clock_timestamp())*1000)::double precision AS epoch_ms");
    const deadline = new Date(Math.floor(native.rows[0].epoch_ms) - 60000);
    const earlier = new Date(deadline.getTime() - 10 * 60000);
    await database.$transaction([database.appointment.update({ where: { id: booking.view.id }, data: { createdAt: earlier, holdExpiresAt: deadline } }),
      database.payment.updateMany({ where: { appointmentId: booking.view.id }, data: { createdAt: earlier, expiresAt: deadline } })]);
    return deadline.toISOString();
  };
  try {
    await sql.connect(); connected = true;
    const prerequisite = await sql.query<{ public_exists: boolean; gist_exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public') AS public_exists, EXISTS (SELECT 1 FROM pg_extension WHERE extname='btree_gist') AS gist_exists");
    if (!prerequisite.rows[0]?.public_exists || !prerequisite.rows[0]?.gist_exists) throw new SeedConfigurationError("Сначала примените миграции локальной базы; проверка не создаёт расширения в public.");
    await sql.query('CREATE SCHEMA "' + schemaName + '"'); created = true;
    const directory = resolve("prisma/migrations");
    const migrations = (await readdir(directory, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const migration of migrations) await sql.query(await readFile(resolve(directory, migration.name, "migration.sql"), "utf8"));
    await seedDemoCatalog(database, salon);
    await check("Все миграции создают отдельную схему с журналом событий и без платежей", async () => {
      assert.ok(migrations.some(row => row.name === "20261007050000_verified_payment_events"));
      assert.deepEqual(await counts(), [0, 0]);
      assert.equal(await database.appointment.count(), 0);
    });
    await check("TEST требует demo-окружение, сильный секрет и демонстрационный салон", async () => {
      await empty();
      const booking = await book();
      for (const config of [{ APP_ENV: "production" }, { APP_ENV: "" }, { PAYMENT_MODE: "LIVE" },
        { PAYMENT_WEBHOOK_SECRET: "" }, { PAYMENT_WEBHOOK_SECRET: "short-secret" }, { PAYMENT_WEBHOOK_SECRET: "a".repeat(64) }]) {
        enableTest(); Object.assign(process.env, config);
        await assert.rejects(() => pay(booking), paymentError([503]));
        assert.deepEqual(await counts(), [0, 0]);
        assert.equal((await read(booking)).paymentAvailability.mode, "DISABLED");
      }
      enableTest();
      await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: false } });
      try {
        await assert.rejects(() => pay(booking), paymentError([503]));
        assert.equal((await read(booking)).paymentAvailability.canCreate, false);
        assert.deepEqual(await counts(), [0, 0]);
      } finally { await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: true } }); }
      const paymentKey = randomUUID();
      const payment = await pay(booking, paymentKey);
      const signed = await event(payment, "SUCCEEDED");
      process.env.APP_ENV = "production";
      try {
        await assert.rejects(() => pay(booking, paymentKey), paymentError([503]));
        await assert.rejects(() => action(payment, booking, "success"), paymentError([503]));
        await assert.rejects(() => deliver(signed), paymentError([503]));
      } finally { enableTest(); }
      await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: false } });
      try {
        await assert.rejects(() => pay(booking, paymentKey), paymentError([503]));
        await assert.rejects(() => action(payment, booking, "success"), paymentError([503]));
        await assert.rejects(() => deliver(signed), paymentError([503]));
      } finally { await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: true } }); }
      assert.deepEqual(await counts(), [1, 0]);
      assert.equal((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "PENDING");
    });
    await check("Нулевая предоплата подтверждена без возможности создать платёж", async () => {
      await empty();
      await database.salonSettings.update({ where: { id: "salon" }, data: { prepaymentMode: "DISABLED", prepaymentPercentageBps: null } });
      const booking = await book();
      assert.equal(booking.view.status, "CONFIRMED");
      await assert.rejects(() => pay(booking), paymentError([400, 409]));
      assert.deepEqual(await counts(), [0, 0]);
      assert.equal((await read(booking)).paymentAvailability.canCreate, false);
    });
    await check("Создание и действия платежа требуют токен именно его записи", async () => {
      await empty();
      const one = await book();
      const two = await book({ masterId: markId });
      for (const token of ["", "bad-token", two.token]) {
        await assert.rejects(() => createPayment(one.view.id, token, { idempotencyKey: randomUUID() }, { database }), paymentError([404]));
      }
      const payment = await pay(one);
      for (const token of ["", "bad-token", two.token]) {
        await assert.rejects(() => simulateTestPayment(payment.id, token, "success", { database }), paymentError([404]));
      }
      assert.deepEqual(await counts(), [1, 0]);
      assert.equal((await read(one)).status, "WAITING_PAYMENT");
    });
    await check("Сумма и валюта берутся из снимка, клиентские paid/status отклоняются", async () => {
      await empty();
      const booking = await book();
      const variant = await database.serviceVariant.findUniqueOrThrow({ where: { id: menId } });
      await database.serviceVariant.update({ where: { id: menId }, data: { priceMinor: 990000 } });
      await database.salonSettings.update({ where: { id: "salon" }, data: { currency: "USD", prepaymentPercentageBps: 5000 } });
      try {
        await assert.rejects(() => pay(booking, randomUUID(), { amountMinor: 1, currency: "USD", status: "SUCCEEDED", paidMinor: 55000 }), paymentError([400]));
        assert.deepEqual(await counts(), [0, 0]);
        const payment = await pay(booking);
        assert.deepEqual({ provider: payment.provider, mode: payment.mode, amount: payment.amountMinor, currency: payment.currency, status: payment.status },
          { provider: "ROMEO_TEST", mode: "TEST", amount: 55000, currency: "RUB", status: "PENDING" });
        assert.equal(payment.expiresAt, booking.view.holdExpiresAt);
        const view = await read(booking);
        assert.equal(view.paidMinor, 0); assert.equal(view.status, "WAITING_PAYMENT");
      } finally { await database.serviceVariant.update({ where: { id: menId }, data: { priceMinor: variant.priceMinor } }); }
    });
    await check("Конкурентные одинаковые и разные ключи дают одну действующую платёжную сессию", async () => {
      await empty();
      const booking = await book();
      const key = randomUUID();
      const identical = await Promise.all(Array.from({ length: 6 }, () => pay(booking, key)));
      assert.equal(new Set(identical.map(row => row.id)).size, 1);
      const distinct = await Promise.all(Array.from({ length: 6 }, () => pay(booking)));
      for (const row of distinct) assert.equal(row.id, identical[0].id);
      assert.equal(await database.paymentRequest.count(), 7);
      assert.deepEqual(await counts(), [1, 0]);
      assert.equal(await database.payment.count({ where: { status: "PENDING" } }), 1);
      const two = await book({ masterId: markId });
      await assert.rejects(() => pay(two, key), paymentError([409]));
      assert.deepEqual(await counts(), [1, 0]);
    });
    await check("Alias-ключ после ошибки возвращает прежнюю попытку и не создаёт новую оплату", async () => {
      await empty();
      const booking = await book();
      const originalKey = randomUUID();
      const aliasKey = randomUUID();
      const original = await pay(booking, originalKey);
      assert.equal((await pay(booking, aliasKey)).id, original.id);
      await action(original, booking, "fail");
      const originalReplay = await pay(booking, originalKey);
      const aliasReplay = await pay(booking, aliasKey);
      assert.equal(originalReplay.id, original.id);
      assert.equal(aliasReplay.id, original.id);
      assert.equal(aliasReplay.status, "FAILED");
      assert.equal(await database.payment.count({ where: { status: "PENDING" } }), 0);
      assert.equal(await database.paymentRequest.count(), 2);
      const retry = await pay(booking);
      assert.notEqual(retry.id, original.id);
      assert.equal(retry.expiresAt, original.expiresAt);
      assert.equal((await pay(booking, aliasKey)).id, original.id);
      assert.equal(await database.payment.count(), 2);
    });
    await check("Подпись, сумма, валюта, провайдер и связь с записью проверяются до изменения БД", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      const valid = await event(payment, "SUCCEEDED");
      const payload = JSON.parse(valid.rawBody) as Record<string, unknown>;
      const invalid = [{ ...valid, signature: "0".repeat(64) }, { ...valid, rawBody: valid.rawBody + " " },
        resign({ ...payload, amountMinor: 1 }), resign({ ...payload, currency: "USD" }),
        resign({ ...payload, providerPaymentId: randomUUID() }), resign({ ...payload, appointmentId: randomUUID() }),
        resign({ ...payload, paymentId: randomUUID() }), resign({ ...payload, provider: "FOREIGN_PROVIDER" }),
        resign({ ...payload, mode: "LIVE" }), await event(payment, "SUCCEEDED", { now: new Date(Date.now() - 6 * 60000) })];
      for (const signed of invalid) {
        await assert.rejects(() => deliver(signed), paymentError([400, 401, 404, 409]));
        assert.deepEqual(await counts(), [1, 0]);
        assert.equal((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "PENDING");
        assert.equal((await read(booking)).status, "WAITING_PAYMENT");
      }
      // Forged provider metadata in this private fixture must not authorize a
      // ROMEO_TEST event against a foreign or LIVE payment.
      for (const forged of [{ provider: "FOREIGN_PROVIDER" }, { mode: "LIVE" as const }]) {
        await database.payment.update({ where: { id: payment.id }, data: forged });
        try { await assert.rejects(() => deliver(valid), paymentError([400, 404, 409, 503])); }
        finally { await database.payment.update({ where: { id: payment.id }, data: { provider: "ROMEO_TEST", mode: "TEST" } }); }
        assert.deepEqual(await counts(), [1, 0]);
      }
    });
    await check("Подписанный callback подтверждает оплату без страницы возврата и открытого браузера", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      const signed = await event(payment, "SUCCEEDED");
      const results = await Promise.all(Array.from({ length: 6 }, () => deliver(signed)));
      assert.equal(results.filter(row => !row.duplicate).length, 1);
      assert.ok(results.every(row => row.accepted === true));
      assert.deepEqual(await counts(), [1, 1]);
      const view = await read(booking);
      assert.equal(view.status, "CONFIRMED"); assert.equal(view.paidMinor, 55000); assert.equal(view.remainingMinor, 165000);
      assert.equal(view.payments[0].status, "SUCCEEDED");
      assert.equal(view.payments[0].refundedAmountMinor, 0);
      assert.ok(view.payments[0].paidAt);
      const native = await sql.query<{ paid_ms: number }>('SELECT (extract(epoch FROM "paidAt")*1000)::double precision AS paid_ms FROM "Payment" WHERE id=$1::uuid', [payment.id]);
      assert.equal(Date.parse(view.payments[0].paidAt!), native.rows[0].paid_ms);
    });
    await check("Повтор события узнаётся по содержимому, изменённый payload того же eventId отклоняется", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      const signed = await event(payment, "SUCCEEDED");
      await deliver(signed);
      const payload = JSON.parse(signed.rawBody) as Record<string, unknown>;
      const reversed = Object.fromEntries(Object.entries(payload).reverse());
      assert.equal((await deliver(resign(reversed))).duplicate, true);
      await assert.rejects(() => deliver(resign({ ...payload, status: "FAILED" })), paymentError([409]));
      assert.deepEqual(await counts(), [1, 1]);
      assert.equal((await read(booking)).paidMinor, 55000);
    });
    await check("Успех не понижается последующими failure, cancel или expire событиями", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      await deliver(await event(payment, "SUCCEEDED"));
      for (const status of ["FAILED", "CANCELLED", "EXPIRED"] as const) {
        await deliver(await event(payment, status));
        const view = await read(booking);
        assert.equal(view.status, "CONFIRMED"); assert.equal(view.paidMinor, 55000);
        assert.equal(view.payments[0].status, "SUCCEEDED");
      }
    });
    await check("Failure, cancel и expiry допускают повтор только в исходном сроке удержания", async () => {
      for (const outcome of ["fail", "cancel", "expire"] as const) {
        await empty();
        const booking = await book();
        const payment = await pay(booking);
        await action(payment, booking, outcome);
        const retry = await pay(booking);
        assert.notEqual(retry.id, payment.id);
        assert.equal(retry.status, "PENDING");
        assert.equal(retry.expiresAt, payment.expiresAt);
        assert.equal((await read(booking)).holdExpiresAt, booking.view.holdExpiresAt);
        assert.equal(await database.payment.count({ where: { status: "PENDING" } }), 1);
      }
    });
    await check("Worker истечения без браузера закрывает запись и её pending-платёж", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      const deadline = await expireFixture(booking);
      assert.equal(await expireAppointmentHolds(database), 1);
      assert.equal((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "EXPIRED");
      assert.equal((await read(booking)).status, "EXPIRED");
      await assert.rejects(() => pay(booking), paymentError([409]));
      assert.deepEqual(await counts(), [1, 0]);
      assert.equal((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).expiresAt!.toISOString(), deadline);
    });
    await check("Поздний успех возвращает свободный интервал с прежним снимком без новой minimumLead", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      await expireFixture(booking); await expireAppointmentHolds(database);
      const variant = await database.serviceVariant.findUniqueOrThrow({ where: { id: menId } });
      await database.serviceVariant.update({ where: { id: menId }, data: { priceMinor: 999000, durationMinutes: 480, bufferMinutes: 120 } });
      await database.salonSettings.update({ where: { id: "salon" }, data: { minimumLeadMinutes: 10080, prepaymentPercentageBps: 5000 } });
      try {
        await deliver(await event(payment, "SUCCEEDED"));
        const view = await read(booking);
        assert.equal(view.status, "CONFIRMED"); assert.equal(view.payments[0].needsAttention, false);
        assert.deepEqual(view.details, booking.view.details);
        assert.equal(view.paidMinor, 55000);
      } finally { await database.serviceVariant.update({ where: { id: menId }, data: {
        priceMinor: variant.priceMinor, durationMinutes: variant.durationMinutes, bufferMinutes: variant.bufferMinutes } }); }
    });
    await check("Поздняя оплата занятого интервала сохраняет SUCCEEDED и attention без двойной записи", async () => {
      await empty();
      const old = await book();
      const payment = await pay(old);
      await expireFixture(old); await expireAppointmentHolds(database);
      const fresh = await book();
      await deliver(await event(payment, "SUCCEEDED"));
      const oldView = await read(old);
      assert.equal(oldView.status, "EXPIRED");
      assert.equal(oldView.payments[0].status, "SUCCEEDED");
      assert.equal(oldView.payments[0].needsAttention, true);
      assert.equal(oldView.payments[0].refundedAmountMinor, 0);
      assert.equal((await read(fresh)).status, "WAITING_PAYMENT");
      assert.equal(await database.appointment.count({ where: { status: { in: ["CONFIRMED", "WAITING_PAYMENT"] } } }), 1);
      const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
      assert.ok(stored.attentionReason);
      assert.equal(stored.refundedAt, null);
    });
    await check("Изменённый график исключает позднее подтверждение, оплата остаётся на сверке", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      await expireFixture(booking); await expireAppointmentHolds(database);
      await database.scheduleException.create({ data: { masterId: alexId, localDate: new Date(date + "T00:00:00Z"), kind: "CLOSED_DAY", reason: "PRIVATE_SCHEDULE_REASON" } });
      await deliver(await event(payment, "SUCCEEDED"));
      const view = await read(booking);
      assert.equal(view.status, "EXPIRED"); assert.equal(view.payments[0].status, "SUCCEEDED"); assert.equal(view.payments[0].needsAttention, true);
      assert.equal(JSON.stringify(view).includes("PRIVATE_SCHEDULE_REASON"), false);
    });
    await check("Одновременные поздняя оплата и новая запись допускают только одного владельца интервала", async () => {
      await empty();
      const old = await book();
      const payment = await pay(old);
      await expireFixture(old); await expireAppointmentHolds(database);
      const signed = await event(payment, "SUCCEEDED");
      const results = await Promise.allSettled([deliver(signed), book()]);
      assert.equal(results[0].status, "fulfilled");
      if (results[1].status === "rejected") assert.ok(results[1].reason instanceof AppointmentError && results[1].reason.status === 409);
      const rows = await database.appointment.findMany({ where: { status: { in: ["CONFIRMED", "WAITING_PAYMENT"] } } });
      assert.equal(rows.length, 1);
      const oldView = await read(old);
      assert.equal(oldView.payments[0].status, "SUCCEEDED");
      assert.equal(oldView.payments[0].needsAttention, oldView.status !== "CONFIRMED");
      assert.equal((await loadDatabaseAvailability({ masterId: alexId, variantIds: [menId], date }, { database })).slots.find(slot => slot.time === "10:00")?.status, "busy");
    });
    await check("Опоздавший успех старой попытки после успешного retry помечает переплату без фиктивного возврата", async () => {
      await empty();
      const booking = await book();
      const old = await pay(booking);
      await action(old, booking, "fail");
      const fresh = await pay(booking);
      await deliver(await event(fresh, "SUCCEEDED"));
      await deliver(await event(old, "SUCCEEDED"));
      const view = await read(booking);
      assert.equal(view.status, "CONFIRMED");
      assert.equal(view.paidMinor, 110000); assert.equal(view.remainingMinor, 110000);
      assert.equal(view.payments.filter(row => row.status === "SUCCEEDED").length, 2);
      assert.equal(view.payments.find(row => row.id === old.id)?.needsAttention, true);
      assert.ok(view.payments.every(row => row.refundedAmountMinor === 0));
      assert.equal(await database.appointment.count(), 1);
    });
    await check("Публичный ответ скрывает секрет, подпись, eventId, providerId и внутренние заметки сверки", async () => {
      await empty();
      const booking = await book();
      const payment = await pay(booking);
      const signed = await event(payment, "SUCCEEDED");
      await deliver(signed);
      const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const logged = await database.paymentEvent.findFirstOrThrow({ where: { paymentId: payment.id } });
      await database.payment.update({ where: { id: payment.id }, data: { needsAttention: true, attentionReason: "PRIVATE_ATTENTION_REASON", failureCode: "PRIVATE_FAILURE_CODE" } });
      const output = JSON.stringify(await read(booking));
      for (const value of [qaSecret, signed.signature, stored.providerPaymentId!, stored.idempotencyKey,
        logged.eventId, logged.payloadFingerprint, "PRIVATE_", "payloadFingerprint", "failureCode", "providerPaymentId", "webhookSecret"]) {
        assert.ok(value); assert.equal(output.includes(value), false);
      }
      assert.equal(await database.payment.count({ where: { mode: "LIVE" } }), 0);
    });
    console.info("Интеграционная проверка TEST-платежей: " + checks + " групп пройдено. Только собственная тестовая схема; реальных списаний нет.");
  } finally {
    await database.$disconnect();
    if (connected) {
      try {
        if (created) {
          if (!safeSchema.test(schemaName)) throw new SeedConfigurationError("Удаление тестовой схемы отклонено.");
          await sql.query('DROP SCHEMA "' + schemaName + '" CASCADE');
        }
      } finally { await sql.end(); }
    }
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
  }
}

main().catch((error: unknown) => {
  console.error("Проверка TEST-платежей не завершена: " + currentCheck + ".");
  // Driver errors and signed event bodies may contain secrets. Do not print them.
  if (error instanceof SeedConfigurationError || error instanceof assert.AssertionError) console.error(error.message);
  else console.error("Проверьте подключение, миграции и результат контрольных утверждений.");
  process.exitCode = 1;
});
