/** Shared client/server rules for the explicitly simulated stage-2 schedule. */
import { addCalendarDays, clockTime, salonDateString, salonDateTimeToInstant, salonTimeParts as zonedParts, validCalendarDate } from "./salon-time";
export { addCalendarDays, clockTime, formatSalonDate, salonDateString, salonDateTimeToInstant } from "./salon-time";
export type AvailabilityPolicy = {
  bookingHorizonDays: number;
  minimumLeadMinutes: number;
  slotStepMinutes: number;
  bufferMinutes: number;
};

export type DemoAvailabilityInput = {
  date: string;
  masterId: string;
  durationMinutes: number;
  timezone: string;
  policy: AvailabilityPolicy;
  now?: Date;
};

export type DemoSlot = {
  time: string;
  endTime: string;
  startAt: string;
  endAt: string;
  blockedUntil: string;
  status: "available" | "past" | "closed" | "busy";
  reason: string;
};

type Interval = { from: number; to: number };
const OPEN = 10 * 60;
const CLOSE = 20 * 60;
const LUNCH: Interval = { from: 14 * 60, to: 15 * 60 };
const MASTER_IDS = ["alex", "anna", "mark"];

function closureReason(date: string, masterId: string): string | null {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (date.endsWith("-01-01") || date.endsWith("-01-02")) return "Праздник · демо";
  if (weekday === 0) return "Выходной салона";
  if ((masterId === "alex" && weekday === 2) || (masterId === "anna" && weekday === 1)) return "Выходной мастера";
  if (masterId === "mark" && Number(date.slice(-2)) === 15) return "Отпуск мастера · демо";
  return null;
}

function demoBusyIntervals(masterId: string): Interval[] {
  if (masterId === "alex") return [{ from: 11 * 60 + 30, to: 12 * 60 + 30 }, { from: 17 * 60, to: 18 * 60 }];
  if (masterId === "anna") return [{ from: 10 * 60 + 30, to: 11 * 60 + 30 }, { from: 16 * 60, to: 17 * 60 + 30 }];
  return [{ from: 12 * 60, to: 13 * 60 }, { from: 16 * 60, to: 17 * 60 }];
}

function intersects(from: number, to: number, interval: Interval) {
  return from < interval.to && to > interval.from;
}

function validPolicy(policy: AvailabilityPolicy) {
  return Number.isInteger(policy.bookingHorizonDays) && policy.bookingHorizonDays >= 1 && policy.bookingHorizonDays <= 366
    && Number.isInteger(policy.minimumLeadMinutes) && policy.minimumLeadMinutes >= 0
    && Number.isInteger(policy.slotStepMinutes) && policy.slotStepMinutes >= 5 && policy.slotStepMinutes <= 120
    && Number.isInteger(policy.bufferMinutes) && policy.bufferMinutes >= 0 && policy.bufferMinutes <= 240;
}

export function getDemoAvailability(input: DemoAvailabilityInput): DemoSlot[] {
  const { date, masterId, durationMinutes, timezone, policy, now = new Date() } = input;
  if (!validCalendarDate(date) || !MASTER_IDS.includes(masterId) || !validPolicy(policy)
    || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 24 * 60
    || !Number.isFinite(now.getTime())) return [];
  const today = salonDateString(now, timezone);
  const last = addCalendarDays(today, policy.bookingHorizonDays - 1);
  const closure = closureReason(date, masterId);
  const busyIntervals = demoBusyIntervals(masterId);
  const slots: DemoSlot[] = [];
  for (let minute = OPEN; minute < CLOSE; minute += policy.slotStepMinutes) {
    const endMinute = minute + durationMinutes;
    const occupiedEnd = endMinute + policy.bufferMinutes;
    const time = clockTime(minute);
    const start = salonDateTimeToInstant(date, time, timezone);
    if (!start) continue;
    // Service duration is elapsed time. The end label also uses the salon's zone.
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    const blockedUntil = new Date(end.getTime() + policy.bufferMinutes * 60_000);
    let status: DemoSlot["status"] = "available";
    let reason = "Свободно";
    if (date < today || start.getTime() < now.getTime() + policy.minimumLeadMinutes * 60_000) {
      status = "past"; reason = start.getTime() <= now.getTime() ? "Уже прошло" : "Слишком скоро";
    } else if (date > last) {
      status = "closed"; reason = "Вне горизонта записи";
    } else if (closure) {
      status = "closed"; reason = closure;
    } else if (occupiedEnd > CLOSE || zonedParts(blockedUntil, timezone).date !== date) {
      status = "closed"; reason = "Не успеем до закрытия";
    } else if (intersects(minute, occupiedEnd, LUNCH)) {
      status = "closed"; reason = "Обеденный перерыв";
    } else if (busyIntervals.some(interval => intersects(minute, occupiedEnd, interval))) {
      status = "busy"; reason = "Занято · демо";
    }
    slots.push({ time, endTime: zonedParts(end, timezone).time, startAt: start.toISOString(), endAt: end.toISOString(), blockedUntil: blockedUntil.toISOString(), status, reason });
  }
  return slots;
}

export function getDemoDateAvailability(input: DemoAvailabilityInput) {
  const availableSlots = getDemoAvailability(input).filter(slot => slot.status === "available");
  const today = salonDateString(input.now ?? new Date(), input.timezone);
  let status: DemoSlot["status"] = "available";
  let reason = `${availableSlots.length} свободных`;
  if (!availableSlots.length) {
    if (input.date < today) { status = "past"; reason = "Прошедшая дата"; }
    else if (input.date > addCalendarDays(today, input.policy.bookingHorizonDays - 1)) { status = "closed"; reason = "Позже горизонта"; }
    else { status = "closed"; reason = closureReason(input.date, input.masterId) ?? "Нет свободного времени"; }
  }
  return { date: input.date, status, reason, availableSlots: availableSlots.length };
}

export function findNearestDemoSlot(input: Omit<DemoAvailabilityInput, "date"> & { fromDate?: string }): { date: string; slot: DemoSlot } | null {
  const now = input.now ?? new Date();
  const today = salonDateString(now, input.timezone);
  const from = input.fromDate && validCalendarDate(input.fromDate) && input.fromDate > today ? input.fromDate : today;
  const last = addCalendarDays(today, input.policy.bookingHorizonDays - 1);
  for (let date = from; date <= last; date = addCalendarDays(date, 1)) {
    const slot = getDemoAvailability({ ...input, date, now }).find(item => item.status === "available");
    if (slot) return { date, slot };
  }
  return null;
}
