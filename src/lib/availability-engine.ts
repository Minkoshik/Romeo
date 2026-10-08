import type { AvailabilityDay, AvailabilityInput, AvailabilityResult, AvailabilitySlot, ExceptionRow, WorkingInterval } from "./availability-types";
import { addCalendarDays, clockTime, createSalonDayClock, salonDateString, validCalendarDate } from "./salon-time";

const MINUTE = 60_000;
type InstantInterval = { start: number; end: number };

export class AvailabilityConfigurationError extends Error {
  constructor() {
    super("Расписание временно недоступно. Попробуйте позже.");
    this.name = "AvailabilityConfigurationError";
  }
}

function validInterval(interval: WorkingInterval) {
  return Number.isInteger(interval.startMinute) && Number.isInteger(interval.endMinute)
    && interval.startMinute >= 0 && interval.endMinute <= 1440 && interval.startMinute < interval.endMinute;
}

function validateInput(input: AvailabilityInput) {
  const { policy } = input;
  if (!policy || !Number.isInteger(policy.bookingHorizonDays) || policy.bookingHorizonDays < 1 || policy.bookingHorizonDays > 365
    || !Number.isInteger(policy.minimumLeadMinutes) || policy.minimumLeadMinutes < 0 || policy.minimumLeadMinutes > 10080
    || !Number.isInteger(policy.slotStepMinutes) || policy.slotStepMinutes < 5 || policy.slotStepMinutes > 60
    || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 1
    || !Number.isSafeInteger(input.bufferMinutes) || input.bufferMinutes < 0
    || !Number.isSafeInteger(input.durationMinutes + input.bufferMinutes)
    || !Array.isArray(input.weeklyIntervals) || !Array.isArray(input.exceptionRows) || !Array.isArray(input.occupied)
    || (input.date !== undefined && !validCalendarDate(input.date))) throw new AvailabilityConfigurationError();
  for (const row of input.weeklyIntervals) {
    if (!row || !Number.isInteger(row.dayOfWeek) || row.dayOfWeek < 0 || row.dayOfWeek > 6 || !validInterval(row)) throw new AvailabilityConfigurationError();
  }
  const dates = new Set<string>();
  for (const row of input.exceptionRows) {
    if (!row || !validCalendarDate(row.date) || dates.has(row.date) || !Array.isArray(row.intervals)
      || !["CLOSED_DAY", "REPLACE_DAY", "BLOCKS_ONLY"].includes(row.kind)
      || (row.kind === "CLOSED_DAY" && row.intervals.length > 0)) throw new AvailabilityConfigurationError();
    dates.add(row.date);
    for (const interval of row.intervals) {
      if (!interval || !validInterval(interval) || !["WORKING", "BLOCKED"].includes(interval.kind)
        || (row.kind === "BLOCKS_ONLY" && interval.kind !== "BLOCKED")) throw new AvailabilityConfigurationError();
    }
  }
}

function mergeWorking(intervals: WorkingInterval[]): WorkingInterval[] {
  const merged: WorkingInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startMinute <= previous.endMinute) previous.endMinute = Math.max(previous.endMinute, interval.endMinute);
    else merged.push({ startMinute: interval.startMinute, endMinute: interval.endMinute });
  }
  return merged;
}

function subtractBlocked(working: WorkingInterval[], blocked: WorkingInterval[]): WorkingInterval[] {
  let result = working;
  for (const block of mergeWorking(blocked)) {
    result = result.flatMap(interval => {
      if (block.endMinute <= interval.startMinute || block.startMinute >= interval.endMinute) return [interval];
      const pieces: WorkingInterval[] = [];
      if (block.startMinute > interval.startMinute) pieces.push({ startMinute: interval.startMinute, endMinute: block.startMinute });
      if (block.endMinute < interval.endMinute) pieces.push({ startMinute: block.endMinute, endMinute: interval.endMinute });
      return pieces;
    });
  }
  return result;
}

function daySchedule(weekly: WorkingInterval[], exception?: ExceptionRow) {
  if (exception?.kind === "CLOSED_DAY") return { base: [], working: [] };
  const base = mergeWorking(exception?.kind === "REPLACE_DAY"
    ? exception.intervals.filter(interval => interval.kind === "WORKING") : weekly);
  const blocks = exception?.intervals.filter(interval => interval.kind === "BLOCKED") ?? [];
  return { base, working: subtractBlocked(base, blocks) };
}

function mergedOccupied(input: AvailabilityInput): InstantInterval[] {
  const rows = input.occupied.map(interval => {
    if (!interval) throw new AvailabilityConfigurationError();
    for (const value of [interval.startAt, interval.endAt]) {
      if (!(value instanceof Date) && (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))) throw new AvailabilityConfigurationError();
    }
    const start = new Date(interval.startAt).getTime();
    const end = new Date(interval.endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new AvailabilityConfigurationError();
    return { start, end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: InstantInterval[] = [];
  for (const row of rows) {
    const previous = result[result.length - 1];
    if (previous && row.start <= previous.end) previous.end = Math.max(previous.end, row.end);
    else result.push(row);
  }
  return result;
}

/** Half-open intervals allow an appointment to start exactly after another ends. */
function intersectsOccupied(start: number, end: number, occupied: InstantInterval[]) {
  let low = 0;
  let high = occupied.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (occupied[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  return low < occupied.length && occupied[low].start < end;
}

/**
 * Rechecks an existing visit's exact UTC interval against today's schedule
 * snapshot. Its original start need not lie on a newly configured slot grid;
 * lead time and horizon only constrain creation of a new booking. The caller
 * separately ensures the original visit is still in the future.
 */
export function canFitScheduledInterval(input: AvailabilityInput, startsAt: Date, occupiedUntil: Date): boolean {
  try {
    validateInput(input);
    if (!(startsAt instanceof Date) || !(occupiedUntil instanceof Date)) return false;
    const start = startsAt.getTime();
    const end = occupiedUntil.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
      || end - start !== (input.durationMinutes + input.bufferMinutes) * MINUTE) return false;
    const date = salonDateString(startsAt, input.timezone);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const exception = input.exceptionRows.find(row => row.date === date);
    const schedule = daySchedule(input.weeklyIntervals.filter(row => row.dayOfWeek === weekday), exception);
    const clock = createSalonDayClock(date, input.timezone);
    const fits = schedule.working.some(interval => {
      const from = clock.instantAtMinute(interval.startMinute);
      const to = clock.instantAtMinute(interval.endMinute);
      return from !== null && to !== null && start >= from.getTime() && end <= to.getTime();
    });
    return fits && !intersectsOccupied(start, end, mergedOccupied(input));
  } catch (error) {
    if (error instanceof AvailabilityConfigurationError) throw error;
    throw new AvailabilityConfigurationError();
  }
}

/** Pure calculation over a single server-read schedule snapshot. */
export function calculateAvailability(input: AvailabilityInput): AvailabilityResult {
  try {
    validateInput(input);
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new AvailabilityConfigurationError();
    const today = salonDateString(now, input.timezone);
    const lastDate = addCalendarDays(today, input.policy.bookingHorizonDays - 1);
    const date = input.date ?? today;
    const weekly = Array.from({ length: 7 }, (_, dayOfWeek) => input.weeklyIntervals.filter(row => row.dayOfWeek === dayOfWeek));
    const exceptions = new Map(input.exceptionRows.map(row => [row.date, row]));
    const occupied = mergedOccupied(input);
    const earliest = now.getTime() + input.policy.minimumLeadMinutes * MINUTE;
    const duration = input.durationMinutes * MINUTE;
    const totalElapsed = (input.durationMinutes + input.bufferMinutes) * MINUTE;
    if (!Number.isFinite(new Date(now.getTime() + totalElapsed + 366 * 86_400_000).getTime())) throw new AvailabilityConfigurationError();

    function calculateDay(localDate: string): { day: AvailabilityDay; slots: AvailabilitySlot[] } {
      const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
      const schedule = daySchedule(weekly[weekday], exceptions.get(localDate));
      const day: AvailabilityDay = { date: localDate, status: "closed", reason: "Нерабочий день", availableCount: 0 };
      if (localDate < today) { day.status = "past"; day.reason = "Прошедшая дата"; }
      if (localDate > lastDate) { day.reason = "Вне горизонта записи"; return { day, slots: [] }; }
      if (!schedule.base.length) return { day, slots: [] };
      const clock = createSalonDayClock(localDate, input.timezone);
      const windows = schedule.working.flatMap(interval => {
        const from = clock.instantAtMinute(interval.startMinute);
        const to = clock.instantAtMinute(interval.endMinute);
        return from && to && to.getTime() > from.getTime() ? [{ start: from.getTime(), end: to.getTime() }] : [];
      });
      const slots: AvailabilitySlot[] = [];
      const candidates = new Set<number>();
      for (let index = 0; index < schedule.base.length; index++) {
        const interval = schedule.base[index];
        for (let minute = interval.startMinute; minute < interval.endMinute; minute += input.policy.slotStepMinutes) candidates.add(minute);
        const next = schedule.base[index + 1];
        if (next) for (let minute = interval.endMinute; minute < next.startMinute; minute += input.policy.slotStepMinutes) candidates.add(minute);
      }
      for (const minute of [...candidates].sort((a, b) => a - b)) {
        const start = clock.instantAtMinute(minute);
        if (!start) continue; // Missing or repeated DST wall time cannot be selected.
        const end = new Date(start.getTime() + duration);
        const until = new Date(start.getTime() + totalElapsed);
        let status: AvailabilitySlot["status"] = "available";
        let reason = "Свободно";
        if (localDate < today || start.getTime() < earliest) {
          status = "past"; reason = start.getTime() <= now.getTime() ? "Уже прошло" : "Слишком скоро";
        } else if (!windows.some(interval => start.getTime() >= interval.start && until.getTime() <= interval.end)) {
          status = "closed";
          reason = windows.some(interval => start.getTime() >= interval.start && start.getTime() < interval.end)
            ? "Недостаточно времени до перерыва или закрытия" : "Перерыв в работе";
        } else if (intersectsOccupied(start.getTime(), until.getTime(), occupied)) {
          status = "busy"; reason = "Время занято";
        }
        slots.push({ time: clockTime(minute), endTime: clock.partsAt(end).time, startAt: start.toISOString(), endAt: end.toISOString(), blockedUntil: until.toISOString(), status, reason });
      }
      day.availableCount = slots.filter(slot => slot.status === "available").length;
      if (day.availableCount > 0) { day.status = "available"; day.reason = `Свободных вариантов: ${day.availableCount}`; }
      else if (day.status !== "past") { day.status = "full"; day.reason = "Нет свободного времени для выбранных услуг"; }
      return { day, slots };
    }

    const days: AvailabilityDay[] = [];
    let slots: AvailabilitySlot[] = [];
    let nearest: AvailabilityResult["nearest"] = null;
    const nearestFrom = date > today ? date : today;
    for (let current = today; current <= lastDate; current = addCalendarDays(current, 1)) {
      const result = calculateDay(current);
      days.push(result.day);
      if (current === date) slots = result.slots;
      if (!nearest && current >= nearestFrom) {
        const slot = result.slots.find(item => item.status === "available");
        if (slot) nearest = { date: current, slot };
      }
    }
    if (date < today || date > lastDate) slots = calculateDay(date).slots;
    return { today, lastDate, date, days, slots, nearest };
  } catch (error) {
    if (error instanceof AvailabilityConfigurationError) throw error;
    throw new AvailabilityConfigurationError();
  }
}
