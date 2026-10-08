import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { demoId, seedDemoCatalog, SeedConfigurationError } from "../prisma/seed";
import { CatalogUnavailableError, loadDatabaseCatalog } from "../src/lib/catalog-repository";
import { CatalogSelectionError, resolveCatalogSelection } from "../src/lib/catalog-rules";
import { demoMasters, demoServices } from "../src/lib/demo-catalog";
import { getDemoAvailability } from "../src/lib/demo-availability";
import { buildDemoQuote } from "../src/lib/demo-quote";
import { getSalon } from "../src/lib/salon";

// Every write, migration and seed targets this newly created schema. Never reuse
// a user-provided schema name and never drop public or another preexisting schema.
const schemaName = `qa_romeo_${randomUUID().replaceAll("-", "")}`;
const safeSchema = /^qa_romeo_[a-f0-9]{32}$/;
let checks = 0;

async function check(label: string, run: () => Promise<void>) {
  await run();
  checks++;
  console.info(`✓ ${label}`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SeedConfigurationError("Для интеграционной проверки задайте DATABASE_URL.");
  if (!safeSchema.test(schemaName)) throw new SeedConfigurationError("Небезопасное имя тестовой схемы.");
  if (process.env.NODE_ENV === "production") throw new SeedConfigurationError("Проверка демонстрационного seed запускается вне production.");
  const sql = new Client({ connectionString, connectionTimeoutMillis: 5000, options: `-c search_path=${schemaName},public` });
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 3, connectionTimeoutMillis: 5000, options: `-c timezone=UTC -c search_path=${schemaName},public` }, { schema: schemaName }) });
  let connected = false;
  let created = false;
  try {
    await sql.connect();
    connected = true;
    // migration.sql declares IF NOT EXISTS public/btree_gist. Require both to
    // exist before running it, so the test does not create public DB objects.
    const prerequisites = await sql.query<{ public_exists: boolean; gist_exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') AS public_exists, EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS gist_exists`);
    if (!prerequisites.rows[0]?.public_exists || !prerequisites.rows[0]?.gist_exists) {
      throw new SeedConfigurationError("Сначала примените миграции основной локальной базы: нужны public и btree_gist. Интеграционная проверка не устанавливает их в общей схеме.");
    }
    await sql.query(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    const migrationDirectory = resolve("prisma/migrations");
    const migrations = (await readdir(migrationDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.ok(migrations.includes("20261006000000_initial_foundation"), "Начальная миграция должна присутствовать");
    assert.ok(migrations.includes("20261006020000_salon_buffer_policy"), "Миграция буферов должна присутствовать");
    for (const directory of migrations) {
      await sql.query(await readFile(resolve(migrationDirectory, directory, "migration.sql"), "utf8"));
    }
    await check("Все миграции проекта применены в изолированной схеме", async () => {
      const tables = await sql.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'", [schemaName]);
      assert.equal(tables.rows.length, 20);
      assert.ok(tables.rows.some(row => row.table_name === "PaymentEvent"), "Журнал проверенных платежных событий должен присутствовать");
      assert.ok(tables.rows.some(row => row.table_name === "PaymentRequest"), "Ключи повторных запросов должны сохранять исходную попытку");
      for (const name of ["AdminSession", "AdminLoginThrottle", "AdminMutation"]) assert.ok(tables.rows.some(row => row.table_name === name), "Защита административных операций должна присутствовать");
    });
    await check("Пустая база возвращает понятную ошибку без подстановки демо-каталога", async () => {
      await assert.rejects(() => loadDatabaseCatalog(database), (error: unknown) => error instanceof CatalogUnavailableError && error.message === "Каталог ещё не настроен. Попробуйте позже.");
    });
    await check("Ошибка драйвера скрывается за русской публичной ошибкой", async () => {
      const unavailable = { $transaction: async () => { throw new Error("synthetic connection details must stay private"); } } as unknown as PrismaClient;
      await assert.rejects(() => loadDatabaseCatalog(unavailable), (error: unknown) => error instanceof CatalogUnavailableError && error.message === "Каталог временно недоступен. Попробуйте ещё раз через несколько секунд.");
    });
    const initial = getSalon();
    const salon = { ...initial, policy: { ...initial.policy, prepaymentMode: "PERCENTAGE" as const, prepaymentPercentage: 25, bufferMinutes: 15 } };
    const first = await seedDemoCatalog(database, salon);
    const second = await seedDemoCatalog(database, salon);
    await check("Seed повторяется без дублей: 6 категорий, 10 услуг, 12 вариантов, 3 мастера", async () => {
      assert.deepEqual(second, first);
      assert.deepEqual(await Promise.all([database.serviceCategory.count(), database.service.count(), database.serviceVariant.count(), database.master.count()]), [6, 10, 12, 3]);
      const expectedAssignments = demoMasters.reduce((sum, master) => sum + demoServices.filter(service => master.serviceIds.includes(service.id)).reduce((count, service) => count + service.variants.length, 0), 0);
      assert.equal(await database.masterService.count(), expectedAssignments);
      assert.equal(await database.weeklySchedule.count(), 36);
      assert.deepEqual(await Promise.all([database.customer.count(), database.appointment.count(), database.payment.count(), database.adminUser.count()]), [0, 0, 0, 0]);
    });
    const catalog = await loadDatabaseCatalog(database);
    await check("Репозиторий читает настройки и каталог PostgreSQL", async () => {
      assert.equal(catalog.source, "database");
      assert.equal(catalog.isDemo, true);
      assert.equal(catalog.salon?.policy.bufferMinutes, 15);
      assert.equal(catalog.salon?.policy.prepaymentMode, "PERCENTAGE");
      assert.equal(catalog.salon?.policy.prepaymentPercentage, 25);
      assert.deepEqual([catalog.categories.length, catalog.services.length, catalog.services.flatMap(service => service.variants).length, catalog.masters.length], [6, 10, 12, 3]);
      assert.equal(catalog.services.find(service => service.slug === "womens-cut")?.variants.length, 1);
      assert.equal(catalog.services.find(service => service.slug === "womens-cut")?.variants[0].priceMinor, 280000);
    });
    const menId = demoId("variant", "mens-cut-standard");
    const markId = demoId("master", "mark");
    const annaId = demoId("master", "anna");
    const markAssignmentId = demoId("master-service", "mark:mens-cut-standard");
    await check("Индивидуальные цена и длительность мастера берутся из назначений", async () => {
      const selection = resolveCatalogSelection(catalog, [menId], markId);
      assert.equal(selection.totalPriceMinor, 250000);
      assert.equal(selection.totalDurationMinutes, 75);
      assert.equal(resolveCatalogSelection(catalog, [menId], annaId).totalPriceMinor, 220000);
    });
    await check("Seed отклоняет переназначенный и переименованный вариант без изменения данных", async () => {
      const original = await database.serviceVariant.findUniqueOrThrow({ where: { id: menId } });
      await database.serviceVariant.update({ where: { id: menId }, data: { serviceId: demoId("service", "womens-cut"), slug: "manual-reassigned-cut" } });
      try {
        const before = {
          settings: await database.salonSettings.findMany(),
          categories: await database.serviceCategory.findMany({ orderBy: { id: "asc" } }),
          services: await database.service.findMany({ orderBy: { id: "asc" } }),
          variants: await database.serviceVariant.findMany({ orderBy: { id: "asc" } }),
          masters: await database.master.findMany({ orderBy: { id: "asc" } }),
          assignments: await database.masterService.findMany({ orderBy: { id: "asc" } }),
          schedules: await database.weeklySchedule.findMany({ orderBy: { id: "asc" } }),
        };
        await assert.rejects(() => seedDemoCatalog(database, salon), (error: unknown) => error instanceof SeedConfigurationError && error.message.includes("другой услугой"));
        assert.deepEqual({
          settings: await database.salonSettings.findMany(),
          categories: await database.serviceCategory.findMany({ orderBy: { id: "asc" } }),
          services: await database.service.findMany({ orderBy: { id: "asc" } }),
          variants: await database.serviceVariant.findMany({ orderBy: { id: "asc" } }),
          masters: await database.master.findMany({ orderBy: { id: "asc" } }),
          assignments: await database.masterService.findMany({ orderBy: { id: "asc" } }),
          schedules: await database.weeklySchedule.findMany({ orderBy: { id: "asc" } }),
        }, before);
      } finally { await database.serviceVariant.update({ where: { id: menId }, data: { serviceId: original.serviceId, slug: original.slug } }); }
    });
    await check("Изменённые в базе имя, цена и настройки сразу видны репозиторию", async () => {
      await database.service.update({ where: { id: demoId("service", "mens-cut") }, data: { name: "Контрольная стрижка" } });
      await database.serviceVariant.update({ where: { id: menId }, data: { priceMinor: 234500 } });
      await database.salonSettings.update({ where: { id: "salon" }, data: { name: "Контрольный салон" } });
      const changed = await loadDatabaseCatalog(database);
      assert.equal(changed.salon?.name, "Контрольный салон");
      assert.equal(changed.services.find(service => service.slug === "mens-cut")?.name, "Контрольная стрижка");
      assert.equal(resolveCatalogSelection(changed, [menId], annaId).totalPriceMinor, 234500);
      await seedDemoCatalog(database, salon);
    });
    await check("Подменённые клиентом суммы игнорируются при серверном расчёте по БД", async () => {
      const fresh = await loadDatabaseCatalog(database);
      assert.ok(fresh.salon);
      const now = new Date("2026-10-06T06:00:00.000Z");
      const date = "2026-10-07";
      const slot = getDemoAvailability({ date, masterId: "mark", durationMinutes: 75, timezone: fresh.salon.timezone, policy: fresh.salon.policy, now }).find(item => item.status === "available");
      assert.ok(slot);
      const quote = buildDemoQuote({ variantIds: [menId], masterId: markId, date, time: slot.time, contacts: { name: "Тестовый Клиент", phone: "+79161234567", email: "", comment: "" }, consent: true, totalPriceMinor: 1, totalDurationMinutes: 1, prepaymentMinor: 0, paid: true }, { catalog: fresh, salon: fresh.salon, slots: [slot] });
      assert.equal(quote.totalPriceMinor, 250000);
      assert.equal(quote.totalDurationMinutes, 75);
      assert.equal(quote.prepaymentMinor, 62500);
      assert.equal("paid" in quote, false);
    });
    const archiveTime = new Date("2026-10-07T00:00:00Z");
    for (const archived of [false, true]) {
      const statusLabel = archived ? "архивные" : "неактивные";
      await check(`Репозиторий исключает ${statusLabel} категории со всеми дочерними услугами`, async () => {
        const id = demoId("category", "cuts");
        await database.serviceCategory.update({ where: { id }, data: archived ? { archivedAt: archiveTime } : { isActive: false } });
        try {
          const filtered = await loadDatabaseCatalog(database);
          assert.equal(filtered.categories.some(category => category.id === id), false);
          assert.equal(filtered.services.some(service => service.categoryId === id), false);
          assert.equal(filtered.masters.some(master => master.variantIds?.includes(menId)), false);
        } finally { await database.serviceCategory.update({ where: { id }, data: { isActive: true, archivedAt: null } }); }
      });
      await check(`Репозиторий исключает ${statusLabel} услуги со всеми вариантами`, async () => {
        const id = demoId("service", "mens-cut");
        await database.service.update({ where: { id }, data: archived ? { archivedAt: archiveTime } : { isActive: false } });
        try {
          const filtered = await loadDatabaseCatalog(database);
          assert.equal(filtered.services.some(service => service.id === id), false);
          assert.equal(filtered.masters.some(master => master.variantIds?.includes(menId)), false);
        } finally { await database.service.update({ where: { id }, data: { isActive: true, archivedAt: null } }); }
      });
      await check(`Репозиторий исключает ${statusLabel} варианты и пустые услуги`, async () => {
        await database.serviceVariant.update({ where: { id: menId }, data: archived ? { archivedAt: archiveTime } : { isActive: false } });
        try {
          const filtered = await loadDatabaseCatalog(database);
          assert.equal(filtered.services.some(service => service.slug === "mens-cut"), false);
          assert.equal(filtered.masters.some(master => master.variantIds?.includes(menId)), false);
        } finally { await database.serviceVariant.update({ where: { id: menId }, data: { isActive: true, archivedAt: null } }); }
      });
      await check(`Репозиторий исключает ${archived ? "архивных" : "недоступных для записи"} мастеров`, async () => {
        await database.master.update({ where: { id: markId }, data: archived ? { archivedAt: archiveTime } : { isBookable: false } });
        try { assert.equal((await loadDatabaseCatalog(database)).masters.some(master => master.id === markId), false); }
        finally { await database.master.update({ where: { id: markId }, data: { isBookable: true, archivedAt: null } }); }
      });
      await check(`Репозиторий исключает ${statusLabel} назначения конкретного варианта`, async () => {
        await database.masterService.update({ where: { id: markAssignmentId }, data: archived ? { archivedAt: archiveTime } : { isActive: false } });
        try {
          const filtered = await loadDatabaseCatalog(database);
          assert.equal(filtered.masters.find(master => master.id === markId)?.variantIds?.includes(menId), false);
          assert.throws(() => resolveCatalogSelection(filtered, [menId], markId), CatalogSelectionError);
        } finally { await database.masterService.update({ where: { id: markAssignmentId }, data: { isActive: true, archivedAt: null } }); }
      });
    }
    await check("Совместимость проверяется по точному варианту, а не по родительской услуге", async () => {
      const longId = demoId("variant", "coloring-long");
      const shortId = demoId("variant", "coloring-short");
      const assignmentId = demoId("master-service", "anna:coloring-long");
      await database.masterService.update({ where: { id: assignmentId }, data: { isActive: false } });
      try {
        const filtered = await loadDatabaseCatalog(database);
        assert.equal(resolveCatalogSelection(filtered, [shortId], annaId).totalPriceMinor, 480000);
        assert.throws(() => resolveCatalogSelection(filtered, [longId], annaId), CatalogSelectionError);
      } finally { await database.masterService.update({ where: { id: assignmentId }, data: { isActive: true } }); }
    });
    await check("Нулевая индивидуальная цена сохраняется через PostgreSQL и репозиторий", async () => {
      await database.masterService.update({ where: { id: markAssignmentId }, data: { priceMinorOverride: 0 } });
      try { assert.equal(resolveCatalogSelection(await loadDatabaseCatalog(database), [menId], markId).totalPriceMinor, 0); }
      finally { await database.masterService.update({ where: { id: markAssignmentId }, data: { priceMinorOverride: 250000 } }); }
    });
    await check("SQL отклоняет отрицательную цену и нулевую длительность варианта", async () => {
      await assert.rejects(() => database.serviceVariant.update({ where: { id: menId }, data: { priceMinor: -1 } }));
      await assert.rejects(() => database.serviceVariant.update({ where: { id: menId }, data: { durationMinutes: 0 } }));
      const variant = await database.serviceVariant.findUniqueOrThrow({ where: { id: menId } });
      assert.equal(variant.priceMinor, 220000);
      assert.equal(variant.durationMinutes, 60);
    });
    await check("SQL отклоняет некорректные предоплату и буфер салона", async () => {
      await assert.rejects(() => database.salonSettings.update({ where: { id: "salon" }, data: { prepaymentPercentageBps: 10001 } }));
      await assert.rejects(() => database.salonSettings.update({ where: { id: "salon" }, data: { bufferMinutes: -1 } }));
      const settings = await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } });
      assert.equal(settings.prepaymentPercentageBps, 2500);
      assert.equal(settings.bufferMinutes, 15);
    });
    await check("GiST ограничение отклоняет пересекающиеся рабочие интервалы мастера", async () => {
      await assert.rejects(() => database.weeklySchedule.create({ data: { masterId: markId, dayOfWeek: 1, startMinute: 650, endMinute: 700 } }));
      assert.equal(await database.weeklySchedule.count(), 36);
    });
    await check("Старые женские варианты и назначения архивируются, сохраняя строки и связи", async () => {
      const staleSlugs = ["womens-cut-short", "womens-cut-long"];
      const manualId = randomUUID();
      for (const slug of staleSlugs) {
        await database.serviceVariant.create({ data: { id: demoId("variant", slug), serviceId: demoId("service", "womens-cut"), slug, name: "Старый вариант", priceMinor: 280000, durationMinutes: 60 } });
        await database.masterService.create({ data: { id: demoId("master-service", `anna:${slug}`), masterId: annaId, serviceVariantId: demoId("variant", slug) } });
      }
      await database.serviceVariant.create({ data: { id: manualId, serviceId: demoId("service", "womens-cut"), slug: "manual-extra", name: "Добавленный вручную", priceMinor: 300000, durationMinutes: 60 } });
      const result = await seedDemoCatalog(database, salon);
      assert.equal(result.archivedVariants, 2);
      assert.equal(result.archivedAssignments, 2);
      for (const slug of staleSlugs) {
        const variant = await database.serviceVariant.findUniqueOrThrow({ where: { id: demoId("variant", slug) } });
        assert.equal(variant.isActive, false);
        assert.ok(variant.archivedAt);
        const assignment = await database.masterService.findUniqueOrThrow({ where: { id: demoId("master-service", `anna:${slug}`) } });
        assert.equal(assignment.isActive, false);
        assert.ok(assignment.archivedAt);
        assert.equal(assignment.serviceVariantId, variant.id);
        await assert.rejects(() => database.serviceVariant.delete({ where: { id: variant.id } }));
      }
      const manual = await database.serviceVariant.findUniqueOrThrow({ where: { id: manualId } });
      assert.equal(manual.isActive, true);
      assert.equal(manual.archivedAt, null);
      const again = await seedDemoCatalog(database, salon);
      assert.equal(again.archivedVariants, 0);
      assert.equal(again.archivedAssignments, 0);
      const visibleIds = (await loadDatabaseCatalog(database)).services.flatMap(service => service.variants.map(variant => variant.id));
      for (const slug of staleSlugs) assert.equal(visibleIds.includes(demoId("variant", slug)), false);
    });
    await check("Seed не изменяет настройки настоящего салона", async () => {
      await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: false, name: "Настоящий салон" } });
      const before = await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } });
      await assert.rejects(() => seedDemoCatalog(database, salon), SeedConfigurationError);
      assert.deepEqual(await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } }), before);
      await database.salonSettings.update({ where: { id: "salon" }, data: { isDemo: true } });
    });
    for (const entity of ["category", "service", "master"] as const) {
      await check(`Seed не перезаписывает настоящий каталог (${entity})`, async () => {
        const id = demoId(entity, entity === "category" ? "cuts" : entity === "service" ? "mens-cut" : "mark");
        async function setDemo(value: boolean) {
          if (entity === "category") await database.serviceCategory.update({ where: { id }, data: { isDemo: value } });
          else if (entity === "service") await database.service.update({ where: { id }, data: { isDemo: value } });
          else await database.master.update({ where: { id }, data: { isDemo: value } });
        }
        await setDemo(false);
        try {
          const before = await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } });
          await assert.rejects(() => seedDemoCatalog(database, salon), SeedConfigurationError);
          assert.deepEqual(await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } }), before);
        } finally { await setDemo(true); }
      });
    }
    await check("Seed запрещён в production до любого изменения данных", async () => {
      const previous = process.env.NODE_ENV;
      const before = await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } });
      Reflect.set(process.env, "NODE_ENV", "production");
      try { await assert.rejects(() => seedDemoCatalog(database, salon), SeedConfigurationError); }
      finally { if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Reflect.set(process.env, "NODE_ENV", previous); }
      assert.deepEqual(await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" } }), before);
    });
    console.info(`Интеграционные проверки PostgreSQL пройдены: ${checks}.`);
  } finally {
    await database.$disconnect();
    if (connected) {
      try {
        if (created) {
          if (!safeSchema.test(schemaName)) throw new SeedConfigurationError("Удаление тестовой схемы отклонено.");
          await sql.query(`DROP SCHEMA "${schemaName}" CASCADE`);
          console.info("Созданная проверкой временная схема удалена. Рабочие данные не изменялись.");
        }
      } finally { await sql.end(); }
    }
  }
}

main().catch((error: unknown) => {
  // PostgreSQL/Prisma connection errors may contain a URL and credentials.
  console.error("Интеграционная проверка PostgreSQL не завершена.");
  console.error(error instanceof SeedConfigurationError || error instanceof assert.AssertionError ? error.message : "Проверьте подключение, миграции и права на создание собственной тестовой схемы.");
  process.exitCode = 1;
});

