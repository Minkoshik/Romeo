import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient, type AppointmentStatus } from "../src/generated/prisma/client";
import { demoId, seedDemoCatalog, SeedConfigurationError } from "../prisma/seed";
import { loadDatabaseAvailability, loadDatabaseAvailabilityContext, AvailabilityRequestError, AvailabilityUnavailableError } from "../src/lib/availability-repository";
import { getSalon } from "../src/lib/salon";
import { salonDateTimeToInstant } from "../src/lib/salon-time";
import { buildDemoQuote, DemoQuoteError } from "../src/lib/demo-quote";

// All writes, migrations and fixture appointments belong to this newly created
// schema. The public salon and its appointments are never changed by this test.
const schemaName = `qa_romeo_schedule_${randomUUID().replaceAll("-", "")}`;
const safeSchema = /^qa_romeo_schedule_[a-f0-9]{32}$/;
let checks = 0;
async function check(label: string, run: () => Promise<void>) { await run(); checks++; console.info(`✓ ${label}`); }

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SeedConfigurationError("Для проверки расписания задайте DATABASE_URL.");
  if (!safeSchema.test(schemaName) || process.env.NODE_ENV === "production") throw new SeedConfigurationError("Интеграционная проверка запускается только в собственной тестовой схеме вне production.");
  const sql = new Client({ connectionString, connectionTimeoutMillis: 5000, options: `-c search_path=${schemaName},public` });
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 3, connectionTimeoutMillis: 5000, options: `-c timezone=UTC -c search_path=${schemaName},public` }, { schema: schemaName }) });
  let connected = false;
  let created = false;
  const now = new Date("2026-10-05T06:00:00.000Z");
  const date = "2026-10-05";
  const alexId = demoId("master", "alex");
  const annaId = demoId("master", "anna");
  const markId = demoId("master", "mark");
  const menId = demoId("variant", "mens-cut-standard");
  const womenId = demoId("variant", "womens-cut-standard");
  const coloringId = demoId("variant", "coloring-long");
  const markAssignmentId = demoId("master-service", "mark:mens-cut-standard");
  const instant = (day: string, time: string) => {
    const value = salonDateTimeToInstant(day, time, "Europe/Moscow");
    assert.ok(value); return value;
  };
  const load = (masterId = alexId, day = date, variantIds = [menId]) => loadDatabaseAvailability({ masterId, variantIds, date: day }, { database, now });
  try {
    await sql.connect(); connected = true;
    const prerequisites = await sql.query<{ public_exists: boolean; gist_exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') AS public_exists, EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS gist_exists`);
    if (!prerequisites.rows[0]?.public_exists || !prerequisites.rows[0]?.gist_exists) throw new SeedConfigurationError("Сначала примените миграции локальной базы. Проверка не создаёт расширения в общей схеме.");
    await sql.query(`CREATE SCHEMA "${schemaName}"`); created = true;
    const migrationDirectory = resolve("prisma/migrations");
    for (const entry of (await readdir(migrationDirectory, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      await sql.query(await readFile(resolve(migrationDirectory, entry.name, "migration.sql"), "utf8"));
    }
    await check("Пустая база не подменяется демонстрационным расписанием", async () => {
      await assert.rejects(() => load(), AvailabilityUnavailableError);
    });
    const defaults = getSalon();
    const salon = { ...defaults, timezone: "Europe/Moscow", policy: { ...defaults.policy, bookingHorizonDays: 7, minimumLeadMinutes: 0, slotStepMinutes: 30, bufferMinutes: 15 } };
    await seedDemoCatalog(database, salon);
    await seedDemoCatalog(database, salon);
    await check("Реальные миграции и повторный seed создают рабочую неделю без записей клиентов", async () => {
      assert.equal(await database.weeklySchedule.count(), 36);
      assert.deepEqual(await Promise.all([database.customer.count(), database.appointment.count(), database.payment.count()]), [0, 0, 0]);
    });
    await check("Слоты читают рабочие часы и обед PostgreSQL с UTC в зоне салона", async () => {
      const availability = await load();
      assert.equal(availability.source, "database");
      assert.equal(availability.today, date);
      assert.equal(availability.lastDate, "2026-10-11");
      assert.equal(availability.days.length, 7);
      assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "available");
      assert.equal(availability.slots.find(slot => slot.time === "10:00")?.startAt, "2026-10-05T07:00:00.000Z");
      assert.equal(availability.slots.find(slot => slot.time === "13:00")?.status, "closed");
      assert.equal(availability.days.find(day => day.date === "2026-10-11")?.status, "closed");
      assert.equal(availability.totalDurationMinutes, 60);
      assert.equal(availability.totalBufferMinutes, 15);
    });
    await check("Расписание произвольного UUID-мастера не зависит от demo slug", async () => {
      const id = randomUUID();
      await database.master.create({ data: { id, slug: "qa-custom-master", name: "Новый мастер", specialization: "Стрижки", description: "Проверка расписания" } });
      await database.masterService.create({ data: { masterId: id, serviceVariantId: menId } });
      await database.weeklySchedule.create({ data: { masterId: id, dayOfWeek: 1, startMinute: 600, endMinute: 720 } });
      const availability = await load(id);
      assert.equal(availability.masterId, id);
      assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "available");
      assert.equal(availability.nearest?.date, date);
    });
    await check("Изменённые рабочие часы немедленно изменяют доступность", async () => {
      const id = demoId("weekly-schedule", "alex:1:600");
      await database.weeklySchedule.update({ where: { id }, data: { startMinute: 660 } });
      try {
        const availability = await load();
        assert.equal(availability.slots.some(slot => slot.time === "10:00" && slot.status === "available"), false);
        assert.equal(availability.slots.find(slot => slot.time === "11:00")?.status, "available");
      } finally { await database.weeklySchedule.update({ where: { id }, data: { startMinute: 600 } }); }
    });
    await check("Буферы варианта и мастера суммируются с буфером салона, включая ноль", async () => {
      await database.serviceVariant.update({ where: { id: menId }, data: { bufferMinutes: 20 } });
      await database.masterService.update({ where: { id: markAssignmentId }, data: { bufferMinutesOverride: 5 } });
      try {
        const availability = await load(markId);
        assert.equal(availability.totalPriceMinor, 250000);
        assert.equal(availability.totalDurationMinutes, 75);
        assert.equal(availability.totalBufferMinutes, 20);
        assert.equal(availability.slots.find(slot => slot.time === "18:30")?.status, "closed");
        await database.masterService.update({ where: { id: markAssignmentId }, data: { bufferMinutesOverride: 0 } });
        assert.equal((await load(markId)).totalBufferMinutes, 15);
        assert.equal((await load(annaId)).totalBufferMinutes, 35);
      } finally {
        await database.serviceVariant.update({ where: { id: menId }, data: { bufferMinutes: 0 } });
        await database.masterService.update({ where: { id: markAssignmentId }, data: { bufferMinutesOverride: null } });
      }
    });
    await check("Длительность всего набора учитывает индивидуальные значения и обед", async () => {
      const availability = await load(markId, date, [menId, womenId]);
      assert.equal(availability.totalDurationMinutes, 135);
      assert.equal(availability.totalPriceMinor, 530000);
      assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "available");
      assert.equal(availability.slots.find(slot => slot.time === "12:00")?.status, "closed");
    });
    await check("Набор, не помещающийся в рабочие интервалы, возвращает отсутствие свободных мест", async () => {
      await database.masterService.update({ where: { id: markAssignmentId }, data: { durationMinutesOverride: 800 } });
      try {
        const availability = await load(markId);
        assert.equal(availability.nearest, null);
        assert.equal(availability.days.every(day => day.availableCount === 0), true);
        assert.equal(availability.slots.some(slot => slot.status === "available"), false);
      } finally { await database.masterService.update({ where: { id: markAssignmentId }, data: { durationMinutesOverride: 75 } }); }
    });
    await check("CLOSED_DAY закрывает дату и не раскрывает внутреннюю причину", async () => {
      const row = await database.scheduleException.create({ data: { masterId: alexId, localDate: new Date(`${date}T00:00:00Z`), kind: "CLOSED_DAY", reason: "СЕКРЕТНАЯ ПРИЧИНА qa" } });
      try {
        const availability = await load();
        assert.equal(availability.days[0].status, "closed");
        assert.equal(availability.days[0].availableCount, 0);
        assert.equal(availability.slots.some(slot => slot.status === "available"), false);
        assert.equal(JSON.stringify(availability).includes("СЕКРЕТНАЯ"), false);
        assert.equal(availability.nearest?.date, "2026-10-06");
      } finally { await database.scheduleException.delete({ where: { id: row.id } }); }
    });
    await check("REPLACE_DAY открывает обычный выходной своими рабочими часами", async () => {
      const row = await database.scheduleException.create({ data: { masterId: alexId, localDate: new Date("2026-10-11T00:00:00Z"), kind: "REPLACE_DAY",
        intervals: { create: [{ kind: "WORKING", startMinute: 540, endMinute: 720 }] } } });
      try {
        const availability = await load(alexId, "2026-10-11");
        assert.equal(availability.slots.find(slot => slot.time === "09:00")?.status, "available");
        assert.ok((availability.days.find(day => day.date === "2026-10-11")?.availableCount ?? 0) > 0);
      } finally { await database.scheduleException.delete({ where: { id: row.id } }); }
    });
    await check("REPLACE_DAY заменяет неделю и применяет блокированные интервалы", async () => {
      const row = await database.scheduleException.create({ data: { masterId: alexId, localDate: new Date(`${date}T00:00:00Z`), kind: "REPLACE_DAY",
        intervals: { create: [{ kind: "WORKING", startMinute: 1020, endMinute: 1200 }, { kind: "BLOCKED", startMinute: 1110, endMinute: 1140 }] } } });
      try {
        const availability = await load();
        assert.equal(availability.slots.some(slot => slot.time === "10:00" && slot.status === "available"), false);
        assert.equal(availability.slots.find(slot => slot.time === "17:00")?.status, "available");
        assert.equal(availability.slots.find(slot => slot.time === "17:30")?.status, "closed");
      } finally { await database.scheduleException.delete({ where: { id: row.id } }); }
    });
    await check("BLOCKS_ONLY вычитает перерыв и сохраняет остальные часы недели", async () => {
      const row = await database.scheduleException.create({ data: { masterId: alexId, localDate: new Date(`${date}T00:00:00Z`), kind: "BLOCKS_ONLY",
        intervals: { create: [{ kind: "BLOCKED", startMinute: 660, endMinute: 720 }] } } });
      try {
        const availability = await load();
        assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "closed");
        assert.equal(availability.slots.find(slot => slot.time === "12:00")?.status, "available");
        assert.equal(availability.slots.find(slot => slot.time === "15:00")?.status, "available");
      } finally { await database.scheduleException.delete({ where: { id: row.id } }); }
    });
    await check("Противоречивые исключения графика безопасно закрывают расчёт", async () => {
      for (const kind of ["CLOSED_DAY", "BLOCKS_ONLY"] as const) {
        const row = await database.scheduleException.create({ data: { masterId: alexId, localDate: new Date(`${date}T00:00:00Z`), kind,
          intervals: { create: [{ kind: "WORKING", startMinute: 600, endMinute: 720 }] } } });
        try { await assert.rejects(() => load(), AvailabilityUnavailableError); }
        finally { await database.scheduleException.delete({ where: { id: row.id } }); }
      }
    });
    const customer = await database.customer.create({ data: { name: "PRIVATE_CUSTOMER_NAME", phoneNormalized: "+79160000001", email: "private-qa@example.invalid", adminNotes: "PRIVATE_ADMIN_NOTES" } });
    const fixtureAppointment = (status: AppointmentStatus, start = "10:30", end = "11:30", occupiedEnd = "11:45", masterId = alexId, day = date, holdExpiresAt?: Date) => database.appointment.create({ data: {
      customerId: customer.id, masterId, status, source: "ADMIN", startsAt: instant(day, start), endsAt: instant(day, end), occupiedUntil: instant(day, occupiedEnd),
      ...(holdExpiresAt ? { holdExpiresAt } : {}), createdAt: new Date(now.getTime() - 3_600_000), idempotencyKey: randomUUID(), publicAccessTokenHash: randomUUID(),
      salonNameSnapshot: "PRIVATE_SALON_SNAPSHOT", salonAddressSnapshot: "PRIVATE_ADDRESS", masterNameSnapshot: "PRIVATE_MASTER_NAME",
      customerNameSnapshot: "PRIVATE_CUSTOMER_NAME", customerPhoneSnapshot: "+79160000001", customerEmailSnapshot: "private-qa@example.invalid",
      customerComment: "PRIVATE_CUSTOMER_COMMENT", adminNotes: "PRIVATE_APPOINTMENT_NOTES", timezoneSnapshot: "Europe/Moscow", currency: "RUB",
      totalPriceMinor: 220000, totalDurationMinutes: 60, totalBufferMinutes: 15, prepaymentModeSnapshot: "DISABLED", prepaymentRequiredMinor: 0,
      bookingTermsVersion: "qa", privacyTermsVersion: "qa", consentRecordedAt: now,
    } });
    await check("Подтверждённая запись блокирует длительность и уже занятый буфер", async () => {
      const row = await fixtureAppointment("CONFIRMED");
      try {
        const availability = await load();
        assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "busy");
        assert.equal(availability.slots.find(slot => slot.time === "11:30")?.status, "busy");
        assert.equal(availability.slots.find(slot => slot.time === "12:00")?.status, "available");
        const serialized = JSON.stringify(availability);
        for (const value of [row.id, customer.id, "PRIVATE_", "private-qa@", "+79160000001", "customer", "payment", "idempotency"]) assert.equal(serialized.includes(value), false);
      } finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    await check("Действующее WAITING_PAYMENT удерживает время без изменения записи", async () => {
      const row = await fixtureAppointment("WAITING_PAYMENT", undefined, undefined, undefined, undefined, undefined, new Date(now.getTime() + 600_000));
      try {
        assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "busy");
        assert.deepEqual(await database.appointment.findUniqueOrThrow({ where: { id: row.id } }), row);
      } finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    await check("Истёкшее удержание игнорируется без записи статуса или удаления", async () => {
      const row = await fixtureAppointment("WAITING_PAYMENT", undefined, undefined, undefined, undefined, undefined, new Date(now.getTime() - 1));
      try {
        assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "available");
        assert.deepEqual(await database.appointment.findUniqueOrThrow({ where: { id: row.id } }), row);
      } finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    for (const status of ["CANCELLED", "EXPIRED", "COMPLETED", "NO_SHOW"] as const) {
      await check(`Статус ${status} не блокирует свободное время`, async () => {
        const row = await fixtureAppointment(status);
        try { assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "available"); }
        finally { await database.appointment.delete({ where: { id: row.id } }); }
      });
    }
    await check("Пограничное касание записей разрешено, пересечение запрещено", async () => {
      const row = await fixtureAppointment("CONFIRMED", "11:15", "11:45", "12:00");
      try {
        const availability = await load();
        assert.equal(availability.slots.find(slot => slot.time === "10:00")?.status, "available");
        assert.equal(availability.slots.find(slot => slot.time === "10:30")?.status, "busy");
        assert.equal(availability.slots.find(slot => slot.time === "12:00")?.status, "available");
      } finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    await check("Запись, начавшаяся в прошлую дату, учитывается по UTC-пересечению", async () => {
      const row = await fixtureAppointment("CONFIRMED", "23:30", "23:45", "23:59", alexId, "2026-10-04");
      await database.appointment.update({ where: { id: row.id }, data: { endsAt: instant(date, "10:15"), occupiedUntil: instant(date, "10:30") } });
      try { assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "busy"); }
      finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    await check("Запись другого мастера не блокирует выбранного", async () => {
      const row = await fixtureAppointment("CONFIRMED", undefined, undefined, undefined, annaId);
      try { assert.equal((await load()).slots.find(slot => slot.time === "10:00")?.status, "available"); }
      finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    await check("Контекст цены, каталога и расписания возвращается из одного снимка", async () => {
      const context = await loadDatabaseAvailabilityContext({ masterId: markId, variantIds: [menId], date }, { database, now });
      assert.equal(context.catalog.source, "database");
      assert.equal(context.availability.totalPriceMinor, 250000);
      assert.equal(context.availability.totalDurationMinutes, 75);
      assert.equal(context.catalog.masters.find(master => master.id === markId)?.overrides?.[menId]?.durationMinutes, 75);
    });
    await check("Расчёт перед подтверждением перепроверяет время по свежему расписанию БД", async () => {
      const input = { masterId: alexId, variantIds: [menId], date, time: "10:00", contacts: { name: "Тестовый Клиент", phone: "+79161234567", email: "", comment: "" }, consent: true,
        totalPriceMinor: 1, totalDurationMinutes: 1, totalBufferMinutes: 0, paid: true };
      const before = await loadDatabaseAvailabilityContext(input, { database, now });
      const quote = buildDemoQuote(input, { salon: before.catalog.salon!, catalog: before.catalog, slots: before.availability.slots });
      assert.equal(quote.totalPriceMinor, 220000);
      assert.equal(quote.totalDurationMinutes, 60);
      assert.equal(quote.totalBufferMinutes, 15);
      assert.equal(quote.startsAt, "2026-10-05T07:00:00.000Z");
      assert.equal("paid" in quote, false);
      const row = await fixtureAppointment("CONFIRMED", "10:00", "11:00", "11:15");
      try {
        const after = await loadDatabaseAvailabilityContext(input, { database, now });
        assert.throws(() => buildDemoQuote(input, { salon: after.catalog.salon!, catalog: after.catalog, slots: after.availability.slots }),
          (error: unknown) => error instanceof DemoQuoteError && error.status === 409);
      } finally { await database.appointment.delete({ where: { id: row.id } }); }
    });
    await check("Точный вариант и активность назначения повторно проверяются на сервере", async () => {
      const id = demoId("master-service", "anna:coloring-long");
      await database.masterService.update({ where: { id }, data: { isActive: false } });
      try {
        await assert.rejects(() => load(annaId, date, [coloringId]), AvailabilityRequestError);
        assert.equal((await load(annaId, date, [demoId("variant", "coloring-short")])).totalPriceMinor, 480000);
      } finally { await database.masterService.update({ where: { id }, data: { isActive: true } }); }
    });
    await check("Неверные UUID, календарь, горизонт, дубли и несовместимый выбор отклоняются", async () => {
      for (const input of [
        { masterId: "alex", variantIds: [menId], date },
        { masterId: alexId, variantIds: [menId], date: "2026-02-30" },
        { masterId: alexId, variantIds: [menId], date: "2026-10-04" },
        { masterId: alexId, variantIds: [menId], date: "2026-10-12" },
        { masterId: randomUUID(), variantIds: [menId], date },
        { masterId: alexId, variantIds: [randomUUID()], date },
        { masterId: alexId, variantIds: [menId, menId], date },
        { masterId: alexId, variantIds: [coloringId], date },
        { masterId: alexId, variantIds: [], date },
        { masterId: alexId, variantIds: Array.from({ length: 21 }, () => menId), date },
      ]) await assert.rejects(() => loadDatabaseAvailability(input, { database, now }), AvailabilityRequestError);
    });
    await check("Некорректная конфигурация и ошибки драйвера дают безопасную публичную ошибку", async () => {
      await database.salonSettings.update({ where: { id: "salon" }, data: { timezone: "private-invalid-timezone" } });
      try { await assert.rejects(() => load(), (error: unknown) => error instanceof AvailabilityUnavailableError && !error.message.includes("private")); }
      finally { await database.salonSettings.update({ where: { id: "salon" }, data: { timezone: "Europe/Moscow" } }); }
      const failing = { $transaction: async () => { throw new Error("private-driver-credentials"); } } as unknown as PrismaClient;
      await assert.rejects(() => loadDatabaseAvailability({ masterId: alexId, variantIds: [menId], date }, { database: failing, now }),
        (error: unknown) => error instanceof AvailabilityUnavailableError && !error.message.includes("private"));
    });
    await check("Чтение расписания не создаёт записи и платежи в тестовой базе", async () => {
      assert.equal(await database.appointment.count(), 0);
      assert.equal(await database.payment.count(), 0);
    });
    console.info(`Интеграционная проверка расписания: ${checks} проверок пройдено. Использовалась только отдельная тестовая схема.`);
  } finally {
    await database.$disconnect();
    if (created && connected && safeSchema.test(schemaName)) await sql.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    if (connected) await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof SeedConfigurationError ? error.message : "Интеграционная проверка расписания не пройдена. Проверьте локальную базу и результат контрольных утверждений.");
  if (error instanceof assert.AssertionError) console.error(`Утверждение не выполнено: ${error.message}`);
  process.exitCode = 1;
});
