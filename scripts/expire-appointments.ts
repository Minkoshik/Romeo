import "dotenv/config";
import { getDatabase } from "../src/lib/db";
import { expireAppointmentHolds } from "../src/lib/appointment-repository";
import type { PrismaClient } from "../src/generated/prisma/client";

async function main() {
  let database: PrismaClient | undefined;
  try {
    database = getDatabase();
    const count = await expireAppointmentHolds(database);
    console.info(`Истекшие брони освобождены: ${count}.`);
  } catch {
    console.error("Не удалось освободить истекшие брони. Проверьте подключение к базе данных.");
    process.exitCode = 1;
  } finally {
    if (database) {
      try { await database.$disconnect(); } catch {
        console.error("Не удалось завершить подключение к базе данных.");
        process.exitCode = 1;
      }
    }
  }
}

void main();
