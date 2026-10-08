import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getDatabase } from "./db";

export const ADMIN_COOKIE_NAME = "romeo_admin_session";
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 5;
const N = 32768; const R = 8; const P = 1;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const loginSchema = z.object({ email: z.string().trim().max(254).email().transform(value => value.toLowerCase()), password: z.string().min(1).max(256) }).strict();
const provisionSchema = loginSchema.extend({ name: z.string().trim().min(2).max(100), password: z.string().min(12).max(256) });
type DatabaseOptions = { database?: PrismaClient };
export type AdminActor = { id: string; name: string; email: string; role: "OWNER" | "ADMIN" };
export class AdminError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "AdminError"; }
}
export function hashAdminSessionToken(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashAdminPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new AdminError("Пароль должен содержать от 12 до 256 символов.");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
let dummyHash: Promise<string> | undefined;
function getDummyHash() { return dummyHash ??= hashAdminPassword("romeo-unknown-account-" + randomBytes(16).toString("hex")); }
export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 256) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)
    || !/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[5])) {
    await verifyAdminPassword(password, await getDummyHash()); return false;
  }
  const actual = await derive(password, Buffer.from(parts[4], "base64url"));
  const expected = Buffer.from(parts[5], "base64url");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ epoch: number }[]>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision AS epoch`;
  return new Date(rows[0].epoch);
}
function actor(row: { id: string; name: string; emailNormalized: string; role: "OWNER" | "ADMIN" }): AdminActor {
  return { id: row.id, name: row.name, email: row.emailNormalized, role: row.role };
}

/** Locks account and session rows until the administrative mutation commits. */
export async function assertAdminSession(tx: Prisma.TransactionClient, token: string | null): Promise<AdminActor> {
  if (!token || !tokenPattern.test(token)) throw new AdminError("Войдите в административную панель.", 401);
  const rows = await tx.$queryRaw<AdminActor[]>`SELECT a."id", a."name", a."emailNormalized" AS "email", a."role"
    FROM "AdminSession" s INNER JOIN "AdminUser" a ON a."id" = s."adminId"
    WHERE s."tokenHash" = ${hashAdminSessionToken(token)} AND s."revokedAt" IS NULL
      AND s."expiresAt" > clock_timestamp() AND s."sessionVersion" = a."sessionVersion"
      AND a."isActive" = true AND a."archivedAt" IS NULL
    FOR SHARE OF a, s`;
  if (!rows[0]) throw new AdminError("Войдите в административную панель.", 401);
  return rows[0];
}
export async function getAdminSession(token: string | null, options: DatabaseOptions = {}): Promise<AdminActor> {
  if (!token || !tokenPattern.test(token)) throw new AdminError("Войдите в административную панель.", 401);
  try { return await (options.database ?? getDatabase()).$transaction(tx => assertAdminSession(tx, token)); }
  catch (error) { if (error instanceof AdminError) throw error; throw new AdminError("Вход временно недоступен. Повторите попытку позже.", 503); }
}

export async function loginAdmin(input: unknown, options: DatabaseOptions = {}): Promise<{ admin: AdminActor; token: string; expiresAt: Date }> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new AdminError("Укажите корректный email и пароль.", 400);
  const { email, password } = parsed.data;
  const identityHash = hashAdminSessionToken("romeo:admin-login:" + email);
  try {
    const database = options.database ?? getDatabase();
    // Prime the equal-cost unknown-account hash before looking up any identity.
    const unknownHash = await getDummyHash();
    const account = await database.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'romeo:admin-login:' + identityHash}, 0))`;
      const now = await databaseClock(tx);
      const previous = await tx.adminLoginThrottle.findUnique({ where: { identityHash } });
      const withinWindow = previous && now.getTime() - previous.windowStartsAt.getTime() < LOGIN_WINDOW_MS;
      if (withinWindow && previous.attempts >= LOGIN_ATTEMPTS) throw new AdminError("Слишком много попыток входа. Повторите через 15 минут.", 429);
      await tx.adminLoginThrottle.upsert({ where: { identityHash },
        create: { identityHash, attempts: 1, windowStartsAt: now, updatedAt: now },
        update: { attempts: withinWindow ? previous.attempts + 1 : 1, windowStartsAt: withinWindow ? previous.windowStartsAt : now, updatedAt: now } });
      return tx.adminUser.findUnique({ where: { emailNormalized: email } });
    });
    const verified = await verifyAdminPassword(password, account?.passwordHash ?? unknownHash);
    if (!verified || !account || !account.isActive || account.archivedAt) throw new AdminError("Неверный email или пароль.", 401);
    const token = randomBytes(32).toString("base64url");
    return await database.$transaction(async tx => {
      await tx.$executeRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
      const current = await tx.adminUser.findUnique({ where: { id: account.id } });
      if (!current || !current.isActive || current.archivedAt || current.passwordHash !== account.passwordHash || current.sessionVersion !== account.sessionVersion)
        throw new AdminError("Неверный email или пароль.", 401);
      const now = await databaseClock(tx);
      const expiresAt = new Date(now.getTime() + ADMIN_SESSION_SECONDS * 1000);
      await tx.adminSession.create({ data: { adminId: current.id, tokenHash: hashAdminSessionToken(token), sessionVersion: current.sessionVersion, createdAt: now, expiresAt } });
      await tx.adminUser.update({ where: { id: current.id }, data: { lastLoginAt: now } });
      await tx.adminLoginThrottle.deleteMany({ where: { identityHash } });
      await tx.auditLog.create({ data: { actorId: current.id, action: "ADMIN_LOGIN", entityType: "AdminUser", entityId: current.id } });
      return { admin: actor(current), token, expiresAt };
    });
  } catch (error) { if (error instanceof AdminError) throw error; throw new AdminError("Вход временно недоступен. Повторите попытку позже.", 503); }
}
export async function logoutAdmin(token: string | null, options: DatabaseOptions = {}): Promise<void> {
  if (!token || !tokenPattern.test(token)) return;
  try {
    await (options.database ?? getDatabase()).$transaction(async tx => {
      const session = await tx.adminSession.findUnique({ where: { tokenHash: hashAdminSessionToken(token) } });
      if (!session || session.revokedAt) return;
      const now = await databaseClock(tx);
      await tx.adminSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.auditLog.create({ data: { actorId: session.adminId, action: "ADMIN_LOGOUT", entityType: "AdminSession", entityId: session.id } });
    });
  } catch { throw new AdminError("Не удалось завершить сеанс. Повторите попытку.", 503); }
}
/** First owner only: rerunning never resets, reactivates or replaces an account. */
export async function provisionFirstAdmin(input: unknown, options: DatabaseOptions = {}): Promise<{ created: boolean; admin: AdminActor | null }> {
  const parsed = provisionSchema.safeParse(input);
  if (!parsed.success) throw new AdminError("Укажите имя, корректный email и пароль длиной от 12 до 256 символов.");
  try {
    const passwordHash = await hashAdminPassword(parsed.data.password);
    return await (options.database ?? getDatabase()).$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('romeo:first-admin', 0))`;
      if (await tx.adminUser.count()) return { created: false, admin: null };
      const row = await tx.adminUser.create({ data: { emailNormalized: parsed.data.email, name: parsed.data.name, passwordHash, role: "OWNER" } });
      await tx.auditLog.create({ data: { actorId: row.id, action: "ADMIN_PROVISION", entityType: "AdminUser", entityId: row.id } });
      return { created: true, admin: actor(row) };
    });
  } catch (error) { if (error instanceof AdminError) throw error; throw new AdminError("Не удалось создать администратора. Проверьте подключение к базе.", 503); }
}
