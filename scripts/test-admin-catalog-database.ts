import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { demoId, seedDemoCatalog, SeedConfigurationError } from "../prisma/seed";
import { AdminError, loginAdmin, provisionFirstAdmin } from "../src/lib/admin-auth";
import { getAdminCatalog, getAdminSchedule, mutateAdminCatalog, mutateAdminSchedule } from "../src/lib/admin-catalog-repository";
import { createAppointment, getAppointment } from "../src/lib/appointment-repository";
import { loadDatabaseCatalog } from "../src/lib/catalog-repository";
import { loadDatabaseAvailability } from "../src/lib/availability-repository";
import { getSalon } from "../src/lib/salon";
import { addCalendarDays, salonDateString } from "../src/lib/salon-time";

// Every fixture, credential and audit entry belongs to this freshly generated schema.
const schemaName = "qa_romeo_admin_catalog_" + randomUUID().replaceAll("-", "");
const safeSchema = /^qa_romeo_admin_catalog_[a-f0-9]{32}$/;
let checks = 0; let currentCheck = "Подготовка изолированной базы";
async function check(label: string, run: () => Promise<void>) { currentCheck = label; await run(); checks++; console.info("✓ " + label); }
const rejects = (status: number) => (error: unknown) => error instanceof AdminError && error.status === status;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SeedConfigurationError("Задайте DATABASE_URL для проверки административного каталога.");
  if (!safeSchema.test(schemaName) || process.env.NODE_ENV === "production") throw new SeedConfigurationError("Проверка разрешена только в собственной схеме вне production.");
  const options = "-c timezone=UTC -c search_path=" + schemaName + ",public";
  const sql = new Client({ connectionString, options, connectionTimeoutMillis: 5000 });
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, options, max: 8, connectionTimeoutMillis: 5000 }, { schema: schemaName }) });
  let connected = false; let created = false;
  const defaults = getSalon();
  const salon = { ...defaults, timezone: "Europe/Moscow", policy: { ...defaults.policy, minimumLeadMinutes: 0, slotStepMinutes: 30, bookingHorizonDays: 30, bufferMinutes: 15, prepaymentMode: "DISABLED" as const, prepaymentFixedMinor: 0, prepaymentPercentage: 0 } };
  let date = addCalendarDays(salonDateString(new Date(), salon.timezone), 1);
  while (new Date(date + "T12:00:00Z").getUTCDay() === 0) date = addCalendarDays(date, 1);
  const alexId = demoId("master", "alex"); const markId = demoId("master", "mark");
  const menId = demoId("variant", "mens-cut-standard"); const womenService = demoId("service", "womens-cut");
  const password = "QA-only-" + randomBytes(24).toString("base64url");
  const credentials = { email: "qa-admin-catalog@example.invalid", password };
  let token = ""; let phoneCounter = 0;
  const catalog = (input: Record<string, unknown>) => mutateAdminCatalog(token, { idempotencyKey: randomUUID(), ...input }, { database });
  const schedule = (input: Record<string, unknown>) => mutateAdminSchedule(token, { idempotencyKey: randomUUID(), ...input }, { database });
  const book = async (overrides: Record<string, unknown> = {}) => {
    const input = { variantIds: [menId], masterId: alexId, date, time: "10:00", consent: true,
      contacts: { name: "Тестовый клиент административного каталога", phone: "+7916" + String(4000000 + phoneCounter++), email: "qa-admin@example.invalid", comment: "Только собственная схема QA" },
      idempotencyKey: randomUUID(), accessToken: randomBytes(32).toString("base64url"), ...overrides };
    return { input, view: await createAppointment(input, { database }) };
  };
  const weeklyAllDays = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, startMinute: 600, endMinute: 1200 }));
  const clearAppointments = () => database.$transaction([database.paymentRequest.deleteMany(), database.paymentEvent.deleteMany(), database.payment.deleteMany(), database.appointmentItem.deleteMany(), database.appointment.deleteMany(), database.customer.deleteMany()]);
  try {
    await sql.connect(); connected = true;
    const prerequisite = await sql.query<{ gist: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='btree_gist') AS gist");
    if (!prerequisite.rows[0]?.gist) throw new SeedConfigurationError("Сначала примените миграции локальной базы; проверка не меняет public.");
    await sql.query('CREATE SCHEMA "' + schemaName + '"'); created = true;
    const directory = resolve("prisma/migrations");
    for (const migration of (await readdir(directory, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) await sql.query(await readFile(resolve(directory, migration.name, "migration.sql"), "utf8"));
    await seedDemoCatalog(database, salon);
    await provisionFirstAdmin({ ...credentials, name: "QA администратор" }, { database });
    token = (await loginAdmin(credentials, { database })).token;
    await check("Чтение каталога требует действующей административной сессии и скрывает секреты", async () => {
      const view = await getAdminCatalog(token, { database });
      assert.equal(view.currency, "RUB"); assert.equal(view.categories.length, 6); assert.equal(view.services.length, 10); assert.equal(view.masters.length, 3);
      assert.equal(view.services.find(row => row.id === womenService)?.variants.length, 1);
      const serialized = JSON.stringify(view);
      for (const value of [password, token, "passwordHash", "tokenHash", "publicAccessTokenHash", "customerPhoneSnapshot"]) assert.equal(serialized.includes(value), false);
      for (const invalid of [null, "bad", randomBytes(32).toString("base64url")]) {
        await assert.rejects(() => getAdminCatalog(invalid, { database }), rejects(401));
        await assert.rejects(() => getAdminSchedule(invalid, alexId, { database }), rejects(401));
        await assert.rejects(() => mutateAdminCatalog(invalid, {}, { database }), rejects(401));
        await assert.rejects(() => mutateAdminSchedule(invalid, {}, { database }), rejects(401));
      }
    });
    await check("Параллельное повторение создания даёт один объект и один аудит", async () => {
      const input = { op: "category.create", idempotencyKey: randomUUID(), data: { slug: "qa-category", name: "QA категория", sortOrder: 10 } };
      const before = await database.auditLog.count();
      const results = await Promise.all(Array.from({ length: 6 }, () => mutateAdminCatalog(token, input, { database })));
      assert.equal(new Set(results.map(row => row.id)).size, 1);
      assert.equal(await database.serviceCategory.count({ where: { slug: "qa-category" } }), 1);
      assert.equal(await database.auditLog.count(), before + 1);
      assert.equal(await database.adminMutation.count({ where: { id: input.idempotencyKey } }), 1);
      await assert.rejects(() => mutateAdminCatalog(token, { ...input, data: { ...input.data, name: "Другие данные" } }, { database }), rejects(409));
      const owner = await database.adminUser.findUniqueOrThrow({ where: { emailNormalized: credentials.email } });
      await database.adminUser.create({ data: { emailNormalized: "qa-other@example.invalid", name: "QA второй администратор", passwordHash: owner.passwordHash } });
      const other = (await loginAdmin({ email: "qa-other@example.invalid", password }, { database })).token;
      await assert.rejects(() => mutateAdminCatalog(other, input, { database }), rejects(409));
    });
    await check("Создание и изменение услуги, варианта, мастера и назначения с нулевой ценой", async () => {
      const category = await database.serviceCategory.findUniqueOrThrow({ where: { slug: "qa-category" } });
      const service = await catalog({ op: "service.create", data: { categoryId: category.id, slug: "qa-service", name: "QA услуга", shortDescription: "Описание", detailedDescription: "Подробное описание", isFeatured: true } });
      const variant = await catalog({ op: "variant.create", data: { serviceId: service.id, slug: "qa-basic", name: "Основной", priceMinor: 0, durationMinutes: 45, bufferMinutes: 5 } });
      const master = await catalog({ op: "master.create", data: { slug: "qa-master", name: "QA мастер", specialization: "Уход", description: "Описание мастера" } });
      await catalog({ op: "category.update", id: category.id, data: { name: "QA новая категория", description: "Новое описание" } });
      await catalog({ op: "service.update", id: service.id, data: { name: "QA новая услуга", sortOrder: 12 } });
      await catalog({ op: "master.update", id: master.id, data: { description: "Новое описание мастера", photoUrl: "/images/qa.jpg" } });
      const assignment = await catalog({ op: "assignment.upsert", data: { masterId: master.id, serviceVariantId: variant.id, priceMinorOverride: 0, durationMinutesOverride: 30, bufferMinutesOverride: 0 } });
      const stored = await database.masterService.findUniqueOrThrow({ where: { id: assignment.id } });
      assert.equal(stored.priceMinorOverride, 0); assert.equal(stored.bufferMinutesOverride, 0);
      const updated = await catalog({ op: "assignment.upsert", data: { masterId: master.id, serviceVariantId: variant.id, priceMinorOverride: null, durationMinutesOverride: null, bufferMinutesOverride: null } });
      assert.equal(updated.id, assignment.id);
      assert.equal((await database.masterService.findUniqueOrThrow({ where: { id: assignment.id } })).priceMinorOverride, null);
      await catalog({ op: "assignment.archive", id: assignment.id });
      assert.equal((await database.masterService.findUniqueOrThrow({ where: { id: assignment.id } })).isActive, false);
      await catalog({ op: "assignment.upsert", data: { masterId: master.id, serviceVariantId: variant.id } });
      assert.equal((await database.masterService.findUniqueOrThrow({ where: { id: assignment.id } })).archivedAt, null);
    });
    await check("Женская стрижка сохраняет одну активную цену при параллельных изменениях", async () => {
      const before = await database.auditLog.count();
      const attempts = await Promise.allSettled(Array.from({ length: 2 }, (_, index) => catalog({ op: "variant.create", data: { serviceId: womenService, slug: "qa-extra-" + index, name: "Дополнительный", priceMinor: 350000, durationMinutes: 90 } })));
      assert.equal(attempts.filter(result => result.status === "rejected" && rejects(409)(result.reason)).length, 2);
      assert.equal(await database.serviceVariant.count({ where: { serviceId: womenService, isActive: true, archivedAt: null } }), 1);
      assert.equal(await database.auditLog.count(), before);
    });
    await check("Изменение и архивирование каталога сохраняют снимки существующей записи", async () => {
      const booking = await book(); const before = await getAppointment(booking.view.id, booking.input.accessToken, { database });
      const variant = await database.serviceVariant.findUniqueOrThrow({ where: { id: menId } });
      await catalog({ op: "variant.update", id: menId, data: { name: "QA новое название", priceMinor: variant.priceMinor + 12345, durationMinutes: 90, bufferMinutes: 60 } });
      await catalog({ op: "service.update", id: variant.serviceId, data: { name: "QA переименованная услуга" } });
      await catalog({ op: "variant.archive", id: menId });
      const after = await getAppointment(booking.view.id, booking.input.accessToken, { database });
      assert.deepEqual(after.details, before.details); assert.equal(after.status, "CONFIRMED");
      assert.equal(await database.appointmentItem.count({ where: { serviceVariantId: menId } }), 1);
      assert.equal((await loadDatabaseCatalog(database)).services.some(row => row.variants.some(item => item.id === menId)), false);
      await assert.rejects(() => catalog({ op: "assignment.upsert", data: { masterId: markId, serviceVariantId: menId } }), rejects(409));
      await database.serviceVariant.update({ where: { id: menId }, data: { archivedAt: null, isActive: true, name: variant.name, priceMinor: variant.priceMinor, durationMinutes: variant.durationMinutes, bufferMinutes: variant.bufferMinutes } });
      await clearAppointments();
    });
    await check("Архивирование категории и услуги скрывает их в публичном каталоге без удаления", async () => {
      const service = await database.service.findUniqueOrThrow({ where: { slug: "qa-service" } });
      await catalog({ op: "service.archive", id: service.id });
      await catalog({ op: "category.archive", id: service.categoryId });
      assert.equal(await database.service.count({ where: { id: service.id } }), 1);
      assert.equal(await database.serviceCategory.count({ where: { id: service.categoryId } }), 1);
      assert.equal((await loadDatabaseCatalog(database)).services.some(row => row.id === service.id), false);
      await assert.rejects(() => catalog({ op: "service.create", data: { categoryId: service.categoryId, slug: "qa-archived-parent", name: "Нельзя", shortDescription: "Описание" } }), rejects(409));
      await assert.rejects(() => catalog({ op: "category.update", id: service.categoryId, data: { isActive: true } }), rejects(409));
    });
    await check("Строгие параметры отклоняют дробные суммы, чужие поля и неверные интервалы без аудита", async () => {
      const before = await database.auditLog.count();
      await assert.rejects(() => catalog({ op: "variant.update", id: menId, data: { priceMinor: 1.25 } }), rejects(400));
      await assert.rejects(() => catalog({ op: "master.archive", id: "not-a-uuid" }), rejects(400));
      await assert.rejects(() => catalog({ op: "category.create", data: { slug: "qa-category", name: "Дубликат" } }), rejects(409));
      await assert.rejects(() => schedule({ op: "weekly", masterId: alexId, intervals: [{ dayOfWeek: 1, startMinute: 600, endMinute: 900 }, { dayOfWeek: 1, startMinute: 850, endMinute: 1000 }] }), rejects(400));
      await assert.rejects(() => schedule({ op: "exception", masterId: alexId, localDate: "2026-02-30", kind: "CLOSED_DAY", intervals: [] }), rejects(400));
      assert.equal(await database.auditLog.count(), before);
    });
    await check("Расписание заменяется атомарно и повтор того же ключа не дублирует аудит", async () => {
      const input = { op: "weekly", masterId: alexId, idempotencyKey: randomUUID(), intervals: weeklyAllDays };
      const before = await database.auditLog.count();
      const results = await Promise.all(Array.from({ length: 4 }, () => mutateAdminSchedule(token, input, { database })));
      assert.equal(new Set(results.map(row => row.id)).size, 1);
      assert.equal((await getAdminSchedule(token, alexId, { database })).weekly.length, 7);
      assert.equal(await database.auditLog.count(), before + 1);
      await assert.rejects(() => mutateAdminSchedule(token, { ...input, intervals: [] }, { database }), rejects(409));
    });
    await check("Исключения закрытого дня, замены часов и блокировки меняют доступность", async () => {
      await schedule({ op: "exception", masterId: alexId, localDate: date, kind: "CLOSED_DAY", reason: "Отпуск", intervals: [] });
      assert.equal((await loadDatabaseAvailability({ masterId: alexId, variantIds: [menId], date }, { database })).slots.filter(row => row.status === "available").length, 0);
      await schedule({ op: "exception", masterId: alexId, localDate: date, kind: "REPLACE_DAY", reason: "Новые часы", intervals: [{ kind: "WORKING", startMinute: 900, endMinute: 1080 }] });
      assert.equal((await loadDatabaseAvailability({ masterId: alexId, variantIds: [menId], date }, { database })).slots.find(row => row.status === "available")?.time, "15:00");
      await schedule({ op: "exception", masterId: alexId, localDate: date, kind: "BLOCKS_ONLY", reason: "Перерыв", intervals: [{ kind: "BLOCKED", startMinute: 600, endMinute: 720 }] });
      assert.equal((await loadDatabaseAvailability({ masterId: alexId, variantIds: [menId], date }, { database })).slots.find(row => row.status === "available")?.time, "12:00");
      await schedule({ op: "removeException", masterId: alexId, localDate: date });
      assert.equal((await getAdminSchedule(token, alexId, { database })).exceptions.length, 0);
    });
    await check("Изменения защищают подтверждённую запись и весь старый технический буфер", async () => {
      const booking = await book(); const before = await getAdminSchedule(token, alexId, { database });
      const auditBefore = await database.auditLog.count();
      await assert.rejects(() => schedule({ op: "exception", masterId: alexId, localDate: date, kind: "CLOSED_DAY", intervals: [] }), rejects(409));
      await assert.rejects(() => schedule({ op: "exception", masterId: alexId, localDate: date, kind: "BLOCKS_ONLY", intervals: [{ kind: "BLOCKED", startMinute: 660, endMinute: 675 }] }), rejects(409));
      const dayOfWeek = new Date(date + "T12:00:00Z").getUTCDay();
      await assert.rejects(() => schedule({ op: "weekly", masterId: alexId, intervals: weeklyAllDays.map(row => row.dayOfWeek === dayOfWeek ? { ...row, endMinute: 660 } : row) }), rejects(409));
      await assert.rejects(() => catalog({ op: "master.archive", id: alexId }), rejects(409));
      await assert.rejects(() => catalog({ op: "master.update", id: alexId, data: { isBookable: false } }), rejects(409));
      assert.deepEqual(await getAdminSchedule(token, alexId, { database }), before);
      assert.equal(await database.auditLog.count(), auditBefore);
      await schedule({ op: "exception", masterId: alexId, localDate: date, kind: "BLOCKS_ONLY", intervals: [{ kind: "BLOCKED", startMinute: 675, endMinute: 690 }] });
      assert.equal((await getAppointment(booking.view.id, booking.input.accessToken, { database })).status, "CONFIRMED");
      await clearAppointments(); await schedule({ op: "removeException", masterId: alexId, localDate: date });
    });
    await check("Удаление исключения не может вернуть график, несовместимый с записью", async () => {
      await schedule({ op: "weekly", masterId: alexId, intervals: [] });
      await schedule({ op: "exception", masterId: alexId, localDate: date, kind: "REPLACE_DAY", intervals: [{ kind: "WORKING", startMinute: 600, endMinute: 1200 }] });
      await book();
      await assert.rejects(() => schedule({ op: "removeException", masterId: alexId, localDate: date }), rejects(409));
      assert.equal((await getAdminSchedule(token, alexId, { database })).exceptions.length, 1);
      await clearAppointments(); await schedule({ op: "removeException", masterId: alexId, localDate: date });
      await schedule({ op: "weekly", masterId: alexId, intervals: weeklyAllDays });
    });
    await check("Действующая ожидающая бронь защищена, истёкшая освобождается перед изменением", async () => {
      await database.salonSettings.update({ where: { id: "salon" }, data: { prepaymentMode: "PERCENTAGE", prepaymentPercentageBps: 2500, prepaymentFixedMinor: null } });
      const booking = await book(); assert.equal(booking.view.status, "WAITING_PAYMENT");
      await assert.rejects(() => schedule({ op: "exception", masterId: alexId, localDate: date, kind: "CLOSED_DAY", intervals: [] }), rejects(409));
      const clock = await sql.query<{ epoch: number }>("SELECT (extract(epoch FROM clock_timestamp())*1000)::double precision AS epoch");
      const deadline = new Date(clock.rows[0].epoch - 60000);
      await database.appointment.update({ where: { id: booking.view.id }, data: { createdAt: new Date(deadline.getTime() - 600000), holdExpiresAt: deadline } });
      await schedule({ op: "exception", masterId: alexId, localDate: date, kind: "CLOSED_DAY", intervals: [] });
      assert.equal((await database.appointment.findUniqueOrThrow({ where: { id: booking.view.id } })).status, "EXPIRED");
      await clearAppointments(); await schedule({ op: "removeException", masterId: alexId, localDate: date });
      await database.salonSettings.update({ where: { id: "salon" }, data: { prepaymentMode: "DISABLED", prepaymentPercentageBps: null, prepaymentFixedMinor: null } });
    });
    await check("Гонка нового визита и закрытия дня допускает только совместимый результат", async () => {
      const results = await Promise.allSettled([book(), schedule({ op: "exception", masterId: alexId, localDate: date, kind: "CLOSED_DAY", intervals: [] })]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
      const active = await database.appointment.count({ where: { masterId: alexId, status: "CONFIRMED" } });
      const closed = await database.scheduleException.count({ where: { masterId: alexId, kind: "CLOSED_DAY", localDate: new Date(date + "T00:00:00Z") } });
      assert.notEqual(active + closed, 2);
      await clearAppointments();
      if (closed) await schedule({ op: "removeException", masterId: alexId, localDate: date });
    });
    await check("Архивирование мастера без записей сохраняет историю и настройки", async () => {
      const master = await database.master.findUniqueOrThrow({ where: { slug: "qa-master" } });
      await catalog({ op: "master.archive", id: master.id });
      assert.equal((await database.master.findUniqueOrThrow({ where: { id: master.id } })).isBookable, false);
      assert.equal((await loadDatabaseCatalog(database)).masters.some(row => row.id === master.id), false);
      await assert.rejects(() => schedule({ op: "weekly", masterId: master.id, intervals: weeklyAllDays }), rejects(409));
    });
    await check("Административные изменения работают для настоящего салона и журнал не содержит секретов", async () => {
      await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: false } });
      const result = await catalog({ op: "category.create", data: { slug: "qa-real", name: "Настоящая категория" } });
      assert.equal((await database.serviceCategory.findUniqueOrThrow({ where: { id: result.id } })).isDemo, false);
      const logs = await database.auditLog.findMany({ where: { entityId: result.id } });
      assert.equal(logs.length, 1); assert.equal(logs[0].action, "category.create");
      const serialized = JSON.stringify(await database.auditLog.findMany());
      for (const value of [password, token, "passwordHash", "tokenHash", "publicAccessTokenHash", "qa-admin@example.invalid"]) assert.equal(serialized.includes(value), false);
      const mutations = await database.adminMutation.findMany();
      assert.ok(mutations.length > 10);
      assert.ok(mutations.every(row => /^[a-f0-9]{64}$/.test(row.payloadFingerprint)));
    });
    console.info(`Проверено групп административного каталога и расписания: ${checks}.`);
  } finally {
    await database.$disconnect();
    try { if (created && safeSchema.test(schemaName)) await sql.query('DROP SCHEMA "' + schemaName + '" CASCADE'); }
    finally { if (connected) await sql.end(); }
  }
}
main().catch(() => { console.error("Проверка административного каталога не пройдена на этапе: " + currentCheck + ". Подробности подключения и секреты не выводятся."); process.exitCode = 1; });
