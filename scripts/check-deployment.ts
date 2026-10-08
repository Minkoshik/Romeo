import "dotenv/config";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getDatabase } from "../src/lib/db";
import { loadDatabaseCatalog } from "../src/lib/catalog-repository";
import { assessDeployment } from "../src/lib/deployment-check";

async function main() {
  const local = process.argv.includes("--local");
  if (process.argv.slice(2).some(arg => arg !== "--local")) throw new Error("arguments");
  const database = getDatabase();
  try {
    const catalog = await loadDatabaseCatalog(database);
    const owner = await database.adminUser.count({ where: { role: "OWNER", isActive: true, archivedAt: null } });
    const settings = await database.salonSettings.findUniqueOrThrow({ where: { id: "salon" }, select: { isDemo: true } });
    const expected = (await readdir(resolve("prisma/migrations"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    const applied = await database.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const unresolved = await database.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
    const constraints = await database.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM pg_constraint WHERE conname = 'Appointment_no_active_overlap' AND contype = 'x' AND connamespace = current_schema()::regnamespace`;
    const issues = assessDeployment(catalog, owner > 0, process.env, local, settings.isDemo);
    if (expected.some(name => !applied.some(row => row.migration_name === name)) || Number(unresolved[0].count) > 0) issues.push({ level: "error", message: "Не все миграции успешно применены: проверьте prisma migrate status/deploy." });
    if (Number(constraints[0].count) !== 1) issues.push({ level: "error", message: "Не найдено SQL-ограничение пересечения действующих записей." });
    for (const issue of issues) console.info(`${issue.level === "error" ? "ОШИБКА" : "ВНИМАНИЕ"}: ${issue.message}`);
    if (issues.some(issue => issue.level === "error")) process.exitCode = 1;
    else console.info(local ? "Локальная конфигурация, каталог, миграции и защита пересечений проверены." : "Конфигурация, каталог, владелец, миграции и защита пересечений проверены. HTTPS, резервное копирование и мониторинг проверяются при размещении по инструкции.");
  } finally { await database.$disconnect(); }
}
main().catch(() => {
  console.error("Проверка подготовки не выполнена. Проверьте аргументы, DATABASE_URL, доступность PostgreSQL и миграции. Секреты не выводятся.");
  process.exitCode = 1;
});
