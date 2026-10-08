const formatters = new Map<string, Intl.DateTimeFormat>();
const MINUTE = 60_000;

function zonedFormatter(timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    // Bound retained formatters even if an administrator changes the salon zone often.
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function salonTimeParts(instant: Date, timezone: string) {
  const parts = zonedFormatter(timezone).formatToParts(instant);
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    time: `${read("hour")}:${read("minute")}`,
    second: Number(read("second")),
  };
}

export function validCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function salonDateString(now: Date, timezone: string): string {
  return salonTimeParts(now, timezone).date;
}

export function addCalendarDays(date: string, days: number): string {
  if (!validCalendarDate(date) || !Number.isInteger(days)) throw new Error("Некорректная дата календаря");
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function formatSalonDate(date: string): string {
  if (!validCalendarDate(date)) return "Некорректная дата";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function clockTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Offsets are discovered once per salon date, not once per slot. On ordinary
 * days conversion is arithmetic. Around an offset transition each candidate
 * is checked against Intl; missing and repeated wall-clock times are rejected.
 */
export function createSalonDayClock(date: string, timezone: string) {
  if (!validCalendarDate(date)) throw new Error("Некорректная дата календаря");
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36, 48]) {
    const sample = new Date(midnight + hours * 3_600_000);
    const parts = salonTimeParts(sample, timezone);
    offsets.add(Date.parse(`${parts.date}T${parts.time}:${String(parts.second).padStart(2, "0")}Z`) - sample.getTime());
  }
  const values = [...offsets];
  const uniqueOffset = values.length === 1 ? values[0] : null;
  return {
    instantAtMinute(minute: number): Date | null {
      if (!Number.isInteger(minute) || minute < 0 || minute > 1440) return null;
      const wall = midnight + minute * MINUTE;
      if (uniqueOffset !== null) return new Date(wall - uniqueOffset);
      const requestedDate = minute === 1440 ? addCalendarDays(date, 1) : date;
      const requestedTime = minute === 1440 ? "00:00" : clockTime(minute);
      const matches = values.map(offset => new Date(wall - offset)).filter(instant => {
        const parts = salonTimeParts(instant, timezone);
        return parts.date === requestedDate && parts.time === requestedTime;
      });
      return matches.length === 1 ? matches[0] : null;
    },
    partsAt(instant: Date) {
      const localMilliseconds = uniqueOffset === null ? NaN : instant.getTime() + uniqueOffset;
      if (uniqueOffset === null || localMilliseconds < midnight || localMilliseconds > midnight + 2 * 86_400_000) return salonTimeParts(instant, timezone);
      const wall = new Date(localMilliseconds).toISOString();
      return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
    },
  };
}

/** Converts salon wall time independently of the device/server time zone. */
export function salonDateTimeToInstant(date: string, time: string, timezone: string): Date | null {
  if (!validCalendarDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  try {
    return createSalonDayClock(date, timezone).instantAtMinute(Number(time.slice(0, 2)) * 60 + Number(time.slice(3)));
  } catch {
    return null;
  }
}
