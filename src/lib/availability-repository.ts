import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { calculateAvailability, AvailabilityConfigurationError } from "./availability-engine";
import type { DatabaseAvailability } from "./availability-types";
import { readDatabaseCatalog, CatalogUnavailableError } from "./catalog-repository";
import { resolveCatalogSelection, CatalogSelectionError } from "./catalog-rules";
import { getDatabase } from "./db";
import { addCalendarDays, salonDateString, validCalendarDate } from "./salon-time";
import type { Catalog } from "./types";

export class AvailabilityRequestError extends Error {
  constructor(message: string, public readonly fieldErrors?: Record<string, string>) { super(message); }
}

export class AvailabilityUnavailableError extends Error {
  constructor(message = "Расписание временно недоступно. Попробуйте ещё раз через несколько секунд.") { super(message); }
}

const inputSchema = z.object({
  masterId: z.string().uuid(),
  variantIds: z.array(z.string().uuid()).min(1).max(20),
  date: z.string().refine(validCalendarDate).optional(),
});

export type DatabaseAvailabilityInput = { masterId: string; variantIds: string[]; date?: string };
export type DatabaseAvailabilityResult = DatabaseAvailability;

/** Reused by atomic booking creation after its locks, inside the caller's snapshot. */
export async function readDatabaseAvailabilityContext(
  tx: Prisma.TransactionClient, input: DatabaseAvailabilityInput, now: Date,
): Promise<{ catalog: Catalog; availability: DatabaseAvailabilityResult }> {
  const catalog = await readDatabaseCatalog(tx);
  const salon = catalog.salon!;
  const selection = resolveCatalogSelection(catalog, input.variantIds, input.masterId);
  const today = salonDateString(now, salon.timezone);
  const lastDate = addCalendarDays(today, salon.policy.bookingHorizonDays - 1);
  if (input.date && (input.date < today || input.date > lastDate)) {
    throw new AvailabilityRequestError("Выберите дату в пределах доступного периода записи.", { date: "Дата находится вне периода записи" });
  }
  // Conservative UTC envelope covers all salon timezones and DST changes.
  // Intersect occupiedUntil to include visits starting before the first date.
  const rangeStart = new Date(Date.parse(`${today}T00:00:00Z`) - 36 * 3_600_000);
  const rangeEnd = new Date(Date.parse(`${addCalendarDays(lastDate, 1)}T00:00:00Z`) + 36 * 3_600_000);
  const [weeklyIntervals, exceptionRows, occupied] = await Promise.all([
    tx.weeklySchedule.findMany({ where: { masterId: selection.master.id }, select: { dayOfWeek: true, startMinute: true, endMinute: true }, orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] }),
    tx.scheduleException.findMany({
      where: { masterId: selection.master.id, localDate: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${lastDate}T00:00:00Z`) } },
      select: { localDate: true, kind: true, intervals: { select: { kind: true, startMinute: true, endMinute: true }, orderBy: { startMinute: "asc" } } }, orderBy: { localDate: "asc" },
    }),
    tx.appointment.findMany({
      where: { masterId: selection.master.id, startsAt: { lt: rangeEnd }, occupiedUntil: { gt: rangeStart }, OR: [{ status: "CONFIRMED" }, { status: "WAITING_PAYMENT", holdExpiresAt: { gt: now } }] },
      // Never read names, contacts, comments, payment data or appointment IDs.
      select: { startsAt: true, occupiedUntil: true }, orderBy: { startsAt: "asc" },
    }),
  ]);
  const availability = calculateAvailability({
    timezone: salon.timezone, policy: salon.policy, durationMinutes: selection.totalDurationMinutes, bufferMinutes: selection.totalBufferMinutes,
    weeklyIntervals, exceptionRows: exceptionRows.map(row => ({ date: row.localDate.toISOString().slice(0, 10), kind: row.kind, intervals: row.intervals })),
    occupied: occupied.map(row => ({ startAt: row.startsAt, endAt: row.occupiedUntil })), date: input.date, now,
  });
  return { catalog, availability: { source: "database", generatedAt: now.toISOString(), timezone: salon.timezone, masterId: selection.master.id,
    totalPriceMinor: selection.totalPriceMinor, totalDurationMinutes: selection.totalDurationMinutes, totalBufferMinutes: selection.totalBufferMinutes, ...availability } };
}

/** Read only. A free slot is a current observation; it does not reserve time. */
export async function loadDatabaseAvailabilityContext(
  input: DatabaseAvailabilityInput,
  options: { database?: PrismaClient; now?: Date } = {},
): Promise<{ catalog: Catalog; availability: DatabaseAvailabilityResult }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AvailabilityRequestError("Проверьте выбранные услуги, мастера и дату.");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AvailabilityUnavailableError();
  try {
    const database = options.database ?? getDatabase();
    return await database.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      return readDatabaseAvailabilityContext(tx, parsed.data, now);
    }, { isolationLevel: "RepeatableRead", timeout: 15000, maxWait: 5000 });
  } catch (error) {
    if (error instanceof AvailabilityRequestError) throw error;
    if (error instanceof CatalogSelectionError) throw new AvailabilityRequestError(error.message, error.fieldErrors);
    if (error instanceof CatalogUnavailableError || error instanceof AvailabilityConfigurationError) throw new AvailabilityUnavailableError();
    // Driver/configuration failures are private. No fixture fallback is allowed.
    throw new AvailabilityUnavailableError();
  }
}

export async function loadDatabaseAvailability(input: DatabaseAvailabilityInput, options: { database?: PrismaClient; now?: Date } = {}): Promise<DatabaseAvailabilityResult> {
  return (await loadDatabaseAvailabilityContext(input, options)).availability;
}
