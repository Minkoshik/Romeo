import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const databaseGlobal = globalThis as typeof globalThis & { romeoPrisma?: PrismaClient };

// One small pool per server process; initialization is lazy so builds need no DB.
export function getDatabase(): PrismaClient {
  if (databaseGlobal.romeoPrisma) return databaseGlobal.romeoPrisma;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Подключение к базе данных не настроено");
  // PrismaPg timestamp encoding requires a UTC session. Salon wall-clock
  // conversion is handled separately by salon-time.ts, never by this session.
  const adapter = new PrismaPg({ connectionString, options: "-c timezone=UTC", max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  const database = new PrismaClient({ adapter });
  databaseGlobal.romeoPrisma = database;
  return database;
}
