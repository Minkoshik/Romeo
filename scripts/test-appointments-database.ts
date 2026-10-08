import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { demoId, seedDemoCatalog, SeedConfigurationError } from "../prisma/seed";
import { AppointmentError, createAppointment, expireAppointmentHolds, getAppointment } from "../src/lib/appointment-repository";
import { loadDatabaseAvailability } from "../src/lib/availability-repository";
import { getSalon } from "../src/lib/salon";
import { addCalendarDays, salonDateString, salonDateTimeToInstant } from "../src/lib/salon-time";

// Every migration, seed and appointment belongs to this newly created schema.
// Public and pre-existing QA schemas are never written to or removed.
const schemaName = "qa_romeo_appointments_" + randomUUID().replaceAll("-", "");
const safeSchema = /^qa_romeo_appointments_[a-f0-9]{32}$/;
let checks = 0;
let currentCheck = "Подготовка собственной тестовой схемы";
async function check(label: string, run: () => Promise<void>) {
  currentCheck = label; await run(); checks++; console.info("✓ " + label);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SeedConfigurationError("Для проверки записей задайте DATABASE_URL.");
  if (!safeSchema.test(schemaName) || process.env.NODE_ENV === "production") throw new SeedConfigurationError("Проверка записей разрешена только в собственной тестовой схеме вне production.");
  const sql = new Client({ connectionString, connectionTimeoutMillis: 5000, options: "-c search_path=" + schemaName + ",public" });
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6, connectionTimeoutMillis: 5000,
    options: "-c search_path=" + schemaName + ",public" }, { schema: schemaName }) });
  let connected = false;
  let created = false;
  const defaults = getSalon();
  const salon = { ...defaults, timezone: "Europe/Moscow", policy: { ...defaults.policy, bookingHorizonDays: 30,
    minimumLeadMinutes: 0, slotStepMinutes: 30, bufferMinutes: 15, holdDurationMinutes: 10,
    prepaymentMode: "PERCENTAGE" as const, prepaymentPercentage: 25,
    bookingTerms: "QA условия записи v1", privacyTerms: "QA правила обработки данных v1" } };
  let date = addCalendarDays(salonDateString(new Date(), salon.timezone), 1);
  while (new Date(date + "T12:00:00Z").getUTCDay() === 0) date = addCalendarDays(date, 1);
  const alexId = demoId("master", "alex");
  const markId = demoId("master", "mark");
  const menId = demoId("variant", "mens-cut-standard");
  const womenId = demoId("variant", "womens-cut-standard");
  let phoneCounter = 0;
  const request = (overrides: Record<string, unknown> = {}) => ({
    variantIds: [menId], masterId: alexId, date, time: "10:00",
    contacts: { name: "Тестовый клиент", phone: "+7916" + String(1000000 + phoneCounter++).padStart(7, "0"),
      email: "qa-appointment@example.invalid", comment: "Только изолированная проверка" },
    consent: true, idempotencyKey: randomUUID(), accessToken: randomBytes(32).toString("base64url"), ...overrides,
  });
  const create = (input: unknown) => createAppointment(input, { database });
  const read = (id: string, token: string) => getAppointment(id, token, { database });
  const load = () => loadDatabaseAvailability({ masterId: alexId, variantIds: [menId], date }, { database });
  const statusError = (status: number) => (error: unknown) => error instanceof AppointmentError && error.status === status;
  const empty = async () => {
    await database.$transaction([database.payment.deleteMany(), database.appointmentItem.deleteMany(),
      database.appointment.deleteMany(), database.customer.deleteMany()]);
  };
  const counts = () => Promise.all([database.appointment.count(), database.customer.count(), database.appointmentItem.count(), database.payment.count()]);
  const termsHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const expectedConditions = { totalPriceMinor: 220000, totalDurationMinutes: 60, totalBufferMinutes: 15,
    prepaymentRequiredMinor: 55000, currency: "RUB", timezone: salon.timezone,
    bookingTermsVersion: termsHash(salon.policy.bookingTerms), privacyTermsVersion: termsHash(salon.policy.privacyTerms) };
  try {
    await sql.connect(); connected = true;
    const prerequisites = await sql.query<{ public_exists: boolean; gist_exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public') AS public_exists, EXISTS (SELECT 1 FROM pg_extension WHERE extname='btree_gist') AS gist_exists");
    if (!prerequisites.rows[0]?.public_exists || !prerequisites.rows[0]?.gist_exists) throw new SeedConfigurationError("Сначала примените миграции локальной базы. Проверка не создаёт расширения в общей схеме.");
    await sql.query('CREATE SCHEMA "' + schemaName + '"'); created = true;
    const migrationDirectory = resolve("prisma/migrations");
    const migrations = (await readdir(migrationDirectory, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const migration of migrations) await sql.query(await readFile(resolve(migrationDirectory, migration.name, "migration.sql"), "utf8"));
    await seedDemoCatalog(database, salon);
    await check("Все миграции создают отдельную базу записей без клиентов и платежей", async () => {
      assert.ok(migrations.length >= 3, "Ожидается миграция полей снимка записи");
      assert.deepEqual(await counts(), [0, 0, 0, 0]);
      assert.equal(await database.master.count(), 3);
      assert.equal(await database.serviceVariant.count(), 12);
    });
    await check("Сервер вычисляет суммы, UTC, буфер и hold по часам PostgreSQL, игнорируя подделку", async () => {
      await empty();
      const input = request({ expectedConditions, totalPriceMinor: 1, totalDurationMinutes: 1, prepaymentRequiredMinor: 0,
        status: "CONFIRMED", paidMinor: 220000, source: "ADMIN" });
      const before = Date.now();
      const view = await create(input);
      assert.equal(view.source, "database");
      assert.equal(view.status, "WAITING_PAYMENT");
      assert.match(view.id, /^[a-f0-9-]{36}$/);
      assert.ok(view.number > 0);
      assert.deepEqual({ price: view.details.totalPriceMinor, duration: view.details.totalDurationMinutes,
        buffer: view.details.totalBufferMinutes, prepayment: view.details.prepaymentRequiredMinor },
      { price: 220000, duration: 60, buffer: 15, prepayment: 55000 });
      assert.equal(view.details.startsAt, salonDateTimeToInstant(date, "10:00", salon.timezone)!.toISOString());
      assert.equal(Date.parse(view.details.endsAt) - Date.parse(view.details.startsAt), 60 * 60000);
      assert.equal(Date.parse(view.details.occupiedUntil) - Date.parse(view.details.endsAt), 15 * 60000);
      assert.ok(Date.parse(view.serverNow) >= before - 1000 && Date.parse(view.serverNow) <= Date.now() + 1000);
      assert.ok(view.holdExpiresAt);
      assert.ok(Math.abs(Date.parse(view.holdExpiresAt) - Date.parse(view.createdAt) - 10 * 60000) <= 1000);
      const native = await sql.query<{ created: number; hold: number; start: number; end: number; occupied: number }>(
        'SELECT (extract(epoch FROM "createdAt")*1000)::double precision AS created, (extract(epoch FROM "holdExpiresAt")*1000)::double precision AS hold, ' +
        '(extract(epoch FROM "startsAt")*1000)::double precision AS start, (extract(epoch FROM "endsAt")*1000)::double precision AS end, ' +
        '(extract(epoch FROM "occupiedUntil")*1000)::double precision AS occupied FROM "Appointment" WHERE "id"=$1::uuid', [view.id]);
      assert.equal(Date.parse(view.createdAt), native.rows[0].created, "createdAt должен совпадать с нативным UTC PostgreSQL");
      assert.equal(Date.parse(view.holdExpiresAt), native.rows[0].hold, "holdExpiresAt должен совпадать с нативным UTC PostgreSQL");
      assert.equal(Date.parse(view.details.startsAt), native.rows[0].start, "startsAt должен совпадать с нативным UTC PostgreSQL");
      assert.equal(Date.parse(view.details.endsAt), native.rows[0].end, "endsAt должен совпадать с нативным UTC PostgreSQL");
      assert.equal(Date.parse(view.details.occupiedUntil), native.rows[0].occupied, "occupiedUntil должен совпадать с нативным UTC PostgreSQL");
      assert.ok(native.rows[0].hold > Date.parse(view.serverNow), "Нативный срок hold должен быть в будущем");
      const row = await database.appointment.findUniqueOrThrow({ where: { id: view.id } });
      assert.equal(row.source, "CLIENT");
      assert.equal(row.publicAccessTokenHash, createHash("sha256").update(input.accessToken).digest("hex"));
      assert.notEqual(row.publicAccessTokenHash, input.accessToken);
      assert.deepEqual(await counts(), [1, 1, 1, 0]);
    });
    await check("Шесть одновременных заявок на один слот создают ровно одну запись без сирот", async () => {
      await empty();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => request()).map(create));
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
      for (const row of results) if (row.status === "rejected") assert.ok(statusError(409)(row.reason));
      assert.deepEqual(await counts(), [1, 1, 1, 0]);
      const availability = await load();
      assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "busy");
      assert.equal(availability.slots.find(slot => slot.time === "11:00")?.status, "busy");
      assert.equal(availability.slots.find(slot => slot.time === "11:30")?.status, "available");
    });
    await check("Одновременные разные начала с пересечением услуги допускают одного клиента", async () => {
      await empty();
      const results = await Promise.allSettled([create(request({ time: "10:00" })), create(request({ time: "10:30" }))]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
      for (const row of results) if (row.status === "rejected") assert.ok(statusError(409)(row.reason));
      assert.deepEqual(await counts(), [1, 1, 1, 0]);
    });
    await check("Буфер исключает пересечение, точное касание границ разрешает новую запись", async () => {
      await empty();
      await database.salonSettings.update({ where: { id: "salon" }, data: { slotStepMinutes: 15 } });
      try {
        await create(request());
        await assert.rejects(() => create(request({ time: "11:00" })), statusError(409));
        const adjacent = await create(request({ time: "11:15" }));
        assert.equal(adjacent.details.startsAt, salonDateTimeToInstant(date, "11:15", salon.timezone)!.toISOString());
        assert.deepEqual(await counts(), [2, 2, 2, 0]);
      } finally { await database.salonSettings.update({ where: { id: "salon" }, data: { slotStepMinutes: 30 } }); }
    });
    await check("Шесть повторов одного ключа и токена возвращают одну запись и набор услуг", async () => {
      await empty();
      const input = request({ masterId: markId, variantIds: [menId, womenId] });
      const views = await Promise.all(Array.from({ length: 6 }, () => create(structuredClone(input))));
      assert.equal(new Set(views.map(view => view.id)).size, 1);
      assert.equal(new Set(views.map(view => view.number)).size, 1);
      assert.deepEqual(await counts(), [1, 1, 2, 0]);
      assert.equal(views[0].details.totalPriceMinor, 530000);
      assert.equal(views[0].details.totalDurationMinutes, 135);
      const reordered = await create({ ...input, masterId: markId.toUpperCase(), variantIds: [womenId.toUpperCase(), menId.toUpperCase()],
        contacts: { ...input.contacts, name: "  " + input.contacts.name + "  ", phone: input.contacts.phone.replace("+7", "8") } });
      assert.equal(reordered.id, views[0].id);
      assert.deepEqual(await counts(), [1, 1, 2, 0]);
    });
    await check("Изменённый запрос или токен с прежним ключом дают 409 без раскрытия записи", async () => {
      await empty();
      const input = request();
      const view = await create(input);
      for (const changed of [{ ...input, time: "12:00" }, { ...input, accessToken: randomBytes(32).toString("base64url") },
        { ...input, contacts: { ...input.contacts, comment: "Другая заявка" } },
        { ...input, contacts: { ...input.contacts, name: "Я", phone: "invalid-phone" } }]) {
        await assert.rejects(() => create(changed), (error: unknown) => {
          assert.ok(statusError(409)(error));
          const output = JSON.stringify(error);
          for (const value of [view.id, input.accessToken, input.contacts.phone]) assert.equal(output.includes(value), false);
          return true;
        });
      }
      assert.deepEqual(await counts(), [1, 1, 1, 0]);
    });
    await check("Два мастера принимают одного клиента одновременно без дубликата клиента", async () => {
      await empty();
      const first = request();
      const second = request({ masterId: markId, contacts: first.contacts });
      const views = await Promise.all([create(first), create(second)]);
      assert.notEqual(views[0].id, views[1].id);
      assert.deepEqual(await counts(), [2, 1, 2, 0]);
      assert.equal((await read(views[0].id, first.accessToken)).details.contacts.phone, first.contacts.phone);
      assert.equal((await read(views[1].id, second.accessToken)).details.contacts.phone, first.contacts.phone);
    });
    await check("Несвежие показанные цена, длительность, предоплата и условия отклоняются до записи", async () => {
      await empty();
      for (const changed of [{ totalPriceMinor: 1 }, { totalDurationMinutes: 30 }, { totalBufferMinutes: 0 },
        { prepaymentRequiredMinor: 0 }, { currency: "USD" }, { timezone: "UTC" },
        { bookingTermsVersion: termsHash("Другие условия") }, { privacyTermsVersion: termsHash("Другие правила") }]) {
        await assert.rejects(() => create(request({ expectedConditions: { ...expectedConditions, ...changed } })), statusError(409));
      }
      assert.deepEqual(await counts(), [0, 0, 0, 0]);
    });
    await check("Полные условия по 20000 символов сохраняются, а запрос с хешами помещается в 16 KiB", async () => {
      await empty();
      const bookingTerms = "Б".repeat(20000);
      const privacyTerms = "П".repeat(20000);
      await database.salonSettings.update({ where: { id: "salon" }, data: { bookingTerms, privacyTerms } });
      try {
        const input = request({ expectedConditions: { ...expectedConditions,
          bookingTermsVersion: termsHash(bookingTerms), privacyTermsVersion: termsHash(privacyTerms) } });
        assert.ok(Buffer.byteLength(JSON.stringify(input), "utf8") < 16 * 1024);
        const view = await create(input);
        assert.equal(view.details.bookingTerms, bookingTerms);
        assert.equal(view.details.privacyTerms, privacyTerms);
        assert.equal((await read(view.id, input.accessToken)).details.bookingTerms, bookingTerms);
      } finally { await database.salonSettings.update({ where: { id: "salon" }, data: {
        bookingTerms: salon.policy.bookingTerms, privacyTerms: salon.policy.privacyTerms } }); }
    });
    await check("Контакты, согласие, UUID, услуги и свободное время проверяются без создания клиентов", async () => {
      await empty();
      const input = request();
      for (const value of [{ ...input, consent: false }, { ...input, contacts: { ...input.contacts, name: "Я" } },
        { ...input, contacts: { ...input.contacts, phone: "123" } }, { ...input, contacts: { ...input.contacts, email: "не-email" } },
        { ...input, masterId: "alex" }, { ...input, masterId: randomUUID() }, { ...input, variantIds: [] },
        { ...input, variantIds: [menId, menId] }, { ...input, variantIds: [randomUUID()] }, { ...input, idempotencyKey: "bad-key" },
        { ...input, accessToken: "short" }, { ...input, date: "2026-02-30" }, { ...input, time: "14:00" }]) {
        await assert.rejects(() => create(value), (error: unknown) => error instanceof AppointmentError && [400, 409].includes(error.status));
      }
      assert.deepEqual(await counts(), [0, 0, 0, 0]);
    });
    await check("Конфликт занятого времени откатывает клиента и позиции вместе с записью", async () => {
      await empty(); await create(request());
      const before = await counts();
      await assert.rejects(() => create(request({ time: "10:30" })), statusError(409));
      assert.deepEqual(await counts(), before);
    });
    await check("Действующий hold блокирует слот, не создаёт оплату и не подтверждает запись", async () => {
      await empty();
      const input = request();
      const view = await create(input);
      assert.equal(await expireAppointmentHolds(database), 0);
      assert.equal((await read(view.id, input.accessToken)).status, "WAITING_PAYMENT");
      assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "busy");
      assert.equal(await database.payment.count(), 0);
      assert.equal(await database.appointment.count({ where: { status: "CONFIRMED" } }), 0);
    });
    await check("Фоновое истечение hold без браузера сохраняется в БД и освобождает время", async () => {
      await empty();
      const input = request();
      const view = await create(input);
      await database.appointment.update({ where: { id: view.id }, data: { createdAt: new Date(Date.now() - 120000), holdExpiresAt: new Date(Date.now() - 60000) } });
      assert.equal(await expireAppointmentHolds(database), 1);
      assert.equal(await expireAppointmentHolds(database), 0);
      assert.equal((await database.appointment.findUniqueOrThrow({ where: { id: view.id } })).status, "EXPIRED");
      assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "available");
      const next = await create(request());
      assert.notEqual(next.id, view.id);
      assert.equal(next.status, "WAITING_PAYMENT");
      assert.equal((await read(view.id, input.accessToken)).status, "EXPIRED");
    });
    await check("Создание догоняет просроченный hold перед новой транзакцией после перезапуска", async () => {
      await empty();
      const old = await create(request());
      await database.appointment.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 120000), holdExpiresAt: new Date(Date.now() - 60000) } });
      const fresh = await create(request());
      assert.notEqual(fresh.id, old.id);
      assert.equal((await database.appointment.findUniqueOrThrow({ where: { id: old.id } })).status, "EXPIRED");
      assert.deepEqual(await counts(), [2, 2, 2, 0]);
    });
    await check("Нулевая предоплата во всех режимах подтверждает запись без hold и платежа", async () => {
      for (const mode of ["DISABLED", "FIXED", "PERCENTAGE"] as const) {
        await empty();
        await database.salonSettings.update({ where: { id: "salon" }, data: { prepaymentMode: mode,
          prepaymentFixedMinor: mode === "FIXED" ? 0 : null, prepaymentPercentageBps: mode === "PERCENTAGE" ? 0 : null } });
        try {
          const view = await create(request());
          assert.equal(view.status, "CONFIRMED");
          assert.equal(view.details.prepaymentRequiredMinor, 0);
          assert.equal(view.holdExpiresAt, null);
          assert.ok(view.confirmedAt);
          assert.equal(await database.payment.count(), 0);
          assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "busy");
        } finally { await database.salonSettings.update({ where: { id: "salon" }, data: {
          prepaymentMode: "PERCENTAGE", prepaymentFixedMinor: null, prepaymentPercentageBps: 2500 } }); }
      }
    });
    await check("Чужой, отсутствующий или неверный токен и идентификатор дают одинаковый 404", async () => {
      await empty();
      const one = request();
      const two = request({ masterId: markId });
      const view = await create(one);
      const other = await create(two);
      for (const [id, token] of [[view.id, two.accessToken], [other.id, one.accessToken], [view.id, ""], [view.id, "bad-token"],
        [randomUUID(), one.accessToken], ["bad-id", one.accessToken]]) {
        await assert.rejects(() => read(id, token), (error: unknown) => {
          assert.ok(statusError(404)(error));
          assert.equal(JSON.stringify(error).includes(one.contacts.phone), false);
          assert.equal(JSON.stringify(error).includes(view.id), false);
          return true;
        });
      }
      assert.equal((await read(view.id, one.accessToken)).details.contacts.phone, one.contacts.phone);
    });
    await check("Публичный ответ скрывает токены, отпечатки, заметки и внутренние платежные поля", async () => {
      await empty();
      const input = request();
      const view = await create(input);
      const row = await database.appointment.findUniqueOrThrow({ where: { id: view.id } });
      await database.appointment.update({ where: { id: view.id }, data: { adminNotes: "PRIVATE_APPOINTMENT_ADMIN_NOTE" } });
      await database.customer.update({ where: { id: row.customerId }, data: { adminNotes: "PRIVATE_CUSTOMER_ADMIN_NOTE" } });
      const output = JSON.stringify(await read(view.id, input.accessToken));
      for (const value of [input.accessToken, input.idempotencyKey, row.publicAccessTokenHash, row.requestFingerprint, row.customerId,
        "PRIVATE_", "adminNotes", "idempotency", "requestFingerprint", "AccessToken", "paymentStatus", "providerPaymentId"]) {
        assert.ok(value); assert.equal(output.includes(value), false);
      }
    });
    await check("Снимок и повтор запроса переживают новые цены, условия, имена и архивирование", async () => {
      await empty();
      const input = request({ masterId: markId, variantIds: [menId, womenId] });
      const initial = await create(input);
      const before = structuredClone(initial.details);
      const row = await database.appointment.findUniqueOrThrow({ where: { id: initial.id } });
      await database.customer.update({ where: { id: row.customerId }, data: { name: "Изменённое имя клиента", phoneNormalized: "+79169999999", email: "new@example.invalid" } });
      await database.service.update({ where: { id: demoId("service", "mens-cut") }, data: { name: "Изменённая услуга", isActive: false, archivedAt: new Date() } });
      await database.serviceVariant.update({ where: { id: menId }, data: { name: "Изменённый вариант", priceMinor: 999000, durationMinutes: 20,
        bufferMinutes: 25, isActive: false, archivedAt: new Date() } });
      await database.master.update({ where: { id: markId }, data: { name: "Изменённый мастер", isBookable: false, archivedAt: new Date() } });
      await database.masterService.update({ where: { id: demoId("master-service", "mark:mens-cut-standard") }, data: {
        priceMinorOverride: 100000, durationMinutesOverride: 30, bufferMinutesOverride: 0, isActive: false, archivedAt: new Date() } });
      await database.salonSettings.update({ where: { id: "salon" }, data: { name: "Изменённый салон", address: "Другой адрес",
        phone: "+7 (495) 111-11-11", timezone: "UTC", phoneCountry: "US", bookingTerms: "QA условия v2",
        privacyTerms: "QA правила v2", prepaymentPercentageBps: 5000 } });
      assert.deepEqual((await read(initial.id, input.accessToken)).details, before);
      // A national RU phone must still normalize using the saved country after
      // live salon settings have switched to US and the catalog is archived.
      const replay = await create({ ...input, contacts: { ...input.contacts, phone: input.contacts.phone.replace("+7", "8") } });
      assert.equal(replay.id, initial.id); assert.deepEqual(replay.details, before);
      assert.deepEqual(await counts(), [1, 1, 2, 0]);
      assert.equal(before.totalPriceMinor, 530000);
      assert.equal(before.totalDurationMinutes, 135);
      assert.equal(before.prepaymentRequiredMinor, 132500);
      assert.equal(before.bookingTerms, salon.policy.bookingTerms);
      assert.equal(before.privacyTerms, salon.policy.privacyTerms);
    });
    console.info("Интеграционная проверка записей: " + checks + " групп пройдено. Использовалась только отдельная тестовая схема.");
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
  }
}

main().catch((error: unknown) => {
  console.error("Проверка записей не завершена: " + currentCheck + ".");
  // Driver messages can contain credentials. Show only controlled assertions.
  if (error instanceof SeedConfigurationError || error instanceof assert.AssertionError) console.error(error.message);
  else console.error("Проверьте подключение, миграции и результат контрольных утверждений.");
  process.exitCode = 1;
});
