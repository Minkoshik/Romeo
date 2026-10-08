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
  const schema = new URL(connectionString).searchParams.get("schema") ?? "public";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) throw new Error("Некорректная схема базы данных");
  const adapter = new PrismaPg({ connectionString, options: "-c timezone=UTC -c search_path=" + schema + ",public", max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }, { schema });
  const database = new PrismaClient({ adapter });
  databaseGlobal.romeoPrisma = database;
  return database;
}
