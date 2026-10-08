import assert from "node:assert/strict";
import test from "node:test";
import { AvailabilityConfigurationError, calculateAvailability, canFitScheduledInterval } from "../src/lib/availability-engine";
import type { AvailabilityInput, ExceptionRow } from "../src/lib/availability-types";
import { addCalendarDays, createSalonDayClock, salonDateString, salonDateTimeToInstant } from "../src/lib/salon-time";

const base: AvailabilityInput = {
  date: "2026-10-07", now: new Date("2026-10-07T05:00:00Z"), timezone: "Europe/Moscow",
  policy: { bookingHorizonDays: 5, minimumLeadMinutes: 60, slotStepMinutes: 15 },
  durationMinutes: 60, bufferMinutes: 15,
  weeklyIntervals: [1, 2, 3, 4, 5, 6].flatMap(dayOfWeek => [
    { dayOfWeek, startMinute: 600, endMinute: 840 },
    { dayOfWeek, startMinute: 900, endMinute: 1200 },
  ]),
  exceptionRows: [], occupied: [],
};
const slot = (time: string, override: Partial<AvailabilityInput> = {}) => calculateAvailability({ ...base, ...override }).slots.find(row => row.time === time)!;
const exception = (kind: ExceptionRow["kind"], intervals: ExceptionRow["intervals"] = []): ExceptionRow => ({ date: base.date!, kind, intervals });

test("a full bundle and buffer must fit one uninterrupted working interval", () => {
  assert.equal(slot("12:45").status, "available"); // ends plus buffer exactly at 14:00
  assert.equal(slot("13:00").status, "closed");
  assert.equal(slot("13:00", { bufferMinutes: 0 }).status, "available");
  assert.equal(slot("14:30").reason, "Перерыв в работе");
  assert.equal(slot("18:45").status, "available");
  assert.equal(slot("19:00").status, "closed");
  assert.equal(slot("10:00", { durationMinutes: 300 }).status, "closed");
  assert.equal(calculateAvailability({ ...base, durationMinutes: 301 }).nearest, null);
  assert.equal(calculateAvailability({ ...base, durationMinutes: 100000 }).nearest, null);
  assert.equal(calculateAvailability({ ...base, bufferMinutes: 100000 }).nearest, null);
});

test("half-open occupancy blocks the full visit including its technical buffer", () => {
  const occupied = [{ startAt: "2026-10-07T08:00:00Z", endAt: "2026-10-07T09:00:00Z" }];
  assert.equal(slot("10:00", { occupied }).status, "busy");
  assert.equal(slot("10:00", { occupied, bufferMinutes: 0 }).status, "available");
  assert.equal(slot("11:00", { occupied }).status, "busy");
  assert.equal(slot("12:00", { occupied }).status, "available");
});

test("occupancy that began on a prior salon date is still considered", () => {
  const occupied = [{ startAt: "2026-10-06T19:00:00Z", endAt: "2026-10-07T07:30:00Z" }];
  assert.equal(slot("10:00", { occupied }).status, "busy");
  assert.equal(slot("10:30", { occupied }).status, "available");
});

test("adjacent and overlapping working rows merge before full-duration fitting", () => {
  const weeklyIntervals = [
    { dayOfWeek: 3, startMinute: 600, endMinute: 660 },
    { dayOfWeek: 3, startMinute: 660, endMinute: 720 },
    { dayOfWeek: 3, startMinute: 690, endMinute: 780 },
  ];
  assert.equal(slot("10:00", { weeklyIntervals, durationMinutes: 165 }).status, "available");
  assert.equal(slot("10:15", { weeklyIntervals, durationMinutes: 165 }).status, "closed");
  assert.equal(slot("10:00", { weeklyIntervals, durationMinutes: 166 }).status, "closed");
});

test("closed-day exceptions override weekly hours without exposing private reasons", () => {
  const result = calculateAvailability({ ...base, exceptionRows: [exception("CLOSED_DAY")] });
  assert.deepEqual(result.slots, []);
  assert.equal(result.days[0].status, "closed");
  assert.equal(result.days[0].reason, "Нерабочий день");
  assert.equal(result.nearest?.date, "2026-10-08");
  assert.equal(result.nearest?.slot.time, "10:00");
});

test("replacement hours fully replace weekly hours and can reopen a weekly day off", () => {
  const replacement = exception("REPLACE_DAY", [{ kind: "WORKING", startMinute: 450, endMinute: 570 }]);
  const result = calculateAvailability({ ...base, policy: { ...base.policy, minimumLeadMinutes: 0 }, exceptionRows: [replacement], now: new Date("2026-10-06T20:00:00Z") });
  assert.equal(result.slots[0].time, "07:30");
  assert.equal(result.slots[0].status, "available");
  assert.equal(result.slots.find(row => row.time === "10:00"), undefined);
  const sunday = "2026-10-11";
  const reopen = calculateAvailability({ ...base, date: sunday, exceptionRows: [{ ...replacement, date: sunday }] });
  assert.equal(reopen.days.at(-1)?.status, "available");
  assert.equal(reopen.slots[0].time, "07:30");
});

test("blocked intervals subtract from weekly and replacement hours", () => {
  const block = { kind: "BLOCKED" as const, startMinute: 660, endMinute: 720 };
  const blocks = [exception("BLOCKS_ONLY", [block])];
  assert.equal(slot("10:00", { exceptionRows: blocks }).status, "closed");
  assert.equal(slot("10:00", { exceptionRows: blocks, bufferMinutes: 0 }).status, "available");
  assert.equal(slot("11:00", { exceptionRows: blocks }).status, "closed");
  assert.equal(slot("12:00", { exceptionRows: blocks }).status, "available");
  const replace = [exception("REPLACE_DAY", [{ kind: "WORKING", startMinute: 600, endMinute: 840 }, block])];
  assert.equal(slot("10:00", { exceptionRows: replace }).status, "closed");
  assert.equal(slot("12:00", { exceptionRows: replace }).status, "available");
});

test("calendar distinguishes a day off from a working day with no available starts", () => {
  const result = calculateAvailability({ ...base, occupied: [{ startAt: "2026-10-07T06:00:00Z", endAt: "2026-10-07T18:00:00Z" }] });
  assert.equal(result.days[0].status, "full");
  assert.equal(result.days[0].availableCount, 0);
  assert.equal(result.days.at(-1)?.status, "closed");
  assert.equal(result.nearest?.date, "2026-10-08");
});

test("lead time uses elapsed UTC minutes and horizon includes today exactly once", () => {
  const input = { ...base, now: new Date("2026-10-07T07:30:00Z"), policy: { ...base.policy, bookingHorizonDays: 1 } };
  const result = calculateAvailability(input);
  assert.equal(result.today, "2026-10-07");
  assert.equal(result.lastDate, "2026-10-07");
  assert.equal(result.days.length, 1);
  assert.equal(result.slots.find(row => row.time === "10:00")?.reason, "Уже прошло");
  assert.equal(result.slots.find(row => row.time === "11:15")?.reason, "Слишком скоро");
  assert.equal(result.slots.find(row => row.time === "11:30")?.status, "available");
  assert.deepEqual(calculateAvailability({ ...input, date: "2026-10-08" }).slots, []);
  assert.equal(calculateAvailability({ ...input, date: "2026-10-08" }).nearest, null);
});

test("nearest free action starts at the requested date and never goes backwards", () => {
  const result = calculateAvailability({ ...base, date: "2026-10-09" });
  assert.equal(result.nearest?.date, "2026-10-09");
  assert.equal(calculateAvailability({ ...base, date: "2026-10-06" }).nearest?.date, "2026-10-07");
});

test("slot step is independent of duration and starts at each working interval", () => {
  const weeklyIntervals = [{ dayOfWeek: 3, startMinute: 465, endMinute: 600 }, { dayOfWeek: 3, startMinute: 735, endMinute: 900 }];
  const result = calculateAvailability({ ...base, weeklyIntervals, now: new Date("2026-10-06T22:00:00Z"), policy: { ...base.policy, slotStepMinutes: 30 }, durationMinutes: 45 });
  assert.equal(result.slots[0].time, "07:45");
  assert.equal(result.slots[1].time, "08:15");
  assert.equal(result.slots.find(row => row.time === "12:15")?.status, "available");
  assert.equal(result.slots.find(row => row.time === "12:45")?.status, "available");
  assert.equal(result.slots.find(row => row.time === "12:30"), undefined);
});

test("salon zone defines date and labels independently of the device zone", () => {
  const now = new Date("2026-10-06T22:30:00Z");
  const saved = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const west = calculateAvailability({ ...base, now });
    process.env.TZ = "Asia/Tokyo";
    assert.deepEqual(calculateAvailability({ ...base, now }), west);
    assert.equal(west.today, "2026-10-07");
    assert.equal(west.slots[0].startAt, "2026-10-07T07:00:00.000Z");
    assert.equal(west.slots[0].endTime, "11:00");
    assert.equal(west.slots[0].blockedUntil, "2026-10-07T08:15:00.000Z");
    assert.equal(salonDateString(now, "America/Los_Angeles"), "2026-10-06");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("midnight is a valid interval boundary, and elapsed duration cannot cross it", () => {
  const weeklyIntervals = [{ dayOfWeek: 3, startMinute: 1380, endMinute: 1440 }];
  const exact = slot("23:00", { weeklyIntervals, durationMinutes: 45 });
  assert.equal(exact.status, "available");
  assert.equal(exact.endTime, "23:45");
  assert.equal(exact.blockedUntil, "2026-10-07T21:00:00.000Z");
  assert.equal(slot("23:15", { weeklyIntervals, durationMinutes: 45 }).status, "closed");
});

test("DST spring gaps are rejected while duration remains actual elapsed time", () => {
  const input: AvailabilityInput = { ...base, date: "2026-03-08", timezone: "America/New_York", now: new Date("2026-03-08T04:00:00Z"), policy: { ...base.policy, minimumLeadMinutes: 0, bookingHorizonDays: 2, slotStepMinutes: 30 }, weeklyIntervals: [{ dayOfWeek: 0, startMinute: 0, endMinute: 240 }], durationMinutes: 60, bufferMinutes: 0 };
  const result = calculateAvailability(input);
  assert.equal(result.slots.find(row => row.time === "02:00"), undefined);
  assert.equal(result.slots.find(row => row.time === "02:30"), undefined);
  const beforeJump = result.slots.find(row => row.time === "01:30")!;
  assert.equal(beforeJump.status, "available");
  assert.equal(beforeJump.startAt, "2026-03-08T06:30:00.000Z");
  assert.equal(beforeJump.endAt, "2026-03-08T07:30:00.000Z");
  assert.equal(beforeJump.endTime, "03:30");
  assert.equal(result.slots.find(row => row.time === "03:30")?.status, "closed");
});

test("DST repeated wall times are rejected rather than picking an arbitrary offset", () => {
  const input: AvailabilityInput = { ...base, date: "2026-11-01", timezone: "America/New_York", now: new Date("2026-11-01T03:00:00Z"), policy: { ...base.policy, minimumLeadMinutes: 0, bookingHorizonDays: 2, slotStepMinutes: 30 }, weeklyIntervals: [{ dayOfWeek: 0, startMinute: 0, endMinute: 240 }], durationMinutes: 120, bufferMinutes: 0 };
  const result = calculateAvailability(input);
  assert.equal(result.slots.find(row => row.time === "01:00"), undefined);
  assert.equal(result.slots.find(row => row.time === "01:30"), undefined);
  assert.equal(result.slots.find(row => row.time === "00:00")?.endAt, "2026-11-01T06:00:00.000Z");
  assert.equal(result.slots.find(row => row.time === "00:00")?.endTime, "01:00");
  assert.equal(result.slots.find(row => row.time === "02:00")?.status, "available");
  assert.equal(result.slots.find(row => row.time === "02:30")?.status, "closed");
});

test("DST-unsafe working boundaries close the affected interval", () => {
  const result = calculateAvailability({ ...base, date: "2026-03-08", timezone: "America/New_York", now: new Date("2026-03-08T04:00:00Z"), policy: { ...base.policy, bookingHorizonDays: 2, minimumLeadMinutes: 0 }, weeklyIntervals: [{ dayOfWeek: 0, startMinute: 150, endMinute: 240 }] });
  assert.equal(result.slots.some(row => row.status === "available"), false);
  assert.equal(result.days.at(-1)?.status, "full");
});

test("invalid configuration never silently opens weekly hours or a blocked day", () => {
  const invalid: Partial<AvailabilityInput>[] = [
    { timezone: "Invalid/Timezone" },
    { date: "2026-02-30" },
    { weeklyIntervals: [{ dayOfWeek: 3, startMinute: 600, endMinute: 599 }] },
    { weeklyIntervals: [{ dayOfWeek: 7, startMinute: 600, endMinute: 720 }] },
    { exceptionRows: [exception("CLOSED_DAY", [{ kind: "WORKING", startMinute: 600, endMinute: 720 }])] },
    { exceptionRows: [exception("BLOCKS_ONLY", [{ kind: "WORKING", startMinute: 600, endMinute: 720 }])] },
    { exceptionRows: [exception("CLOSED_DAY"), exception("REPLACE_DAY")] },
    { exceptionRows: [exception("BLOCKS_ONLY", [{ kind: "BLOCKED", startMinute: 600, endMinute: 1441 }])] },
    { occupied: [{ startAt: "not-an-instant", endAt: "2026-10-07T08:00:00Z" }] },
    { occupied: [{ startAt: "2026-10-07T08:00:00", endAt: "2026-10-07T09:00:00Z" }] },
    { occupied: [{ startAt: "2026-10-07T08:00:00Z", endAt: "2026-10-07T07:00:00Z" }] },
  ];
  for (const override of invalid) assert.throws(() => calculateAvailability({ ...base, ...override }), AvailabilityConfigurationError);
});

test("calendar arithmetic and unique conversion work with fractional offsets and date-line changes", () => {
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(salonDateTimeToInstant("2026-10-07", "10:00", "Asia/Kathmandu")?.toISOString(), "2026-10-07T04:15:00.000Z");
  assert.equal(salonDateTimeToInstant("2011-12-30", "10:00", "Pacific/Apia"), null);
  assert.equal(salonDateTimeToInstant("2026-03-08", "02:30", "America/New_York"), null);
  assert.equal(salonDateTimeToInstant("2026-11-01", "01:30", "America/New_York"), null);
  assert.equal(createSalonDayClock("2026-10-07", "Europe/Moscow").instantAtMinute(1440)?.toISOString(), "2026-10-07T21:00:00.000Z");
});

test("maximum horizon and five-minute grid finish without per-slot Intl conversion", () => {
  const result = calculateAvailability({ ...base, policy: { ...base.policy, bookingHorizonDays: 365, slotStepMinutes: 5 }, weeklyIntervals: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, startMinute: 0, endMinute: 1440 })) });
  assert.equal(result.days.length, 365);
  assert.equal(result.slots.length, 288);
  assert.equal(result.lastDate, "2027-10-06");
  assert.ok(result.days.at(-1)!.availableCount > 0);
});

test("an existing UTC visit fits independently of a changed slot grid, lead time and horizon", () => {
  const startsAt = new Date("2026-10-07T07:15:00.000Z");
  const occupiedUntil = new Date("2026-10-07T08:30:00.000Z");
  const changed = { ...base, now: new Date("2027-01-01T00:00:00Z"), policy: { bookingHorizonDays: 1, minimumLeadMinutes: 10080, slotStepMinutes: 60 } };
  assert.equal(canFitScheduledInterval(changed, startsAt, occupiedUntil), true);
  assert.equal(canFitScheduledInterval(changed, startsAt, new Date("2026-10-07T08:29:00.000Z")), false);
  assert.equal(canFitScheduledInterval(changed, new Date(NaN), occupiedUntil), false);
});

test("late-payment interval recheck includes current blocks, closure and the saved technical buffer", () => {
  const startsAt = new Date("2026-10-07T07:15:00.000Z");
  const occupiedUntil = new Date("2026-10-07T08:30:00.000Z");
  assert.equal(canFitScheduledInterval({ ...base, exceptionRows: [exception("CLOSED_DAY")] }, startsAt, occupiedUntil), false);
  assert.equal(canFitScheduledInterval({ ...base, exceptionRows: [exception("BLOCKS_ONLY", [{ kind: "BLOCKED", startMinute: 630, endMinute: 660 }])] }, startsAt, occupiedUntil), false);
  assert.equal(canFitScheduledInterval({ ...base, occupied: [{ startAt: "2026-10-07T08:15:00Z", endAt: "2026-10-07T09:00:00Z" }] }, startsAt, occupiedUntil), false);
  assert.equal(canFitScheduledInterval({ ...base, occupied: [{ startAt: "2026-10-07T08:30:00Z", endAt: "2026-10-07T09:00:00Z" }] }, startsAt, occupiedUntil), true);
  assert.throws(() => canFitScheduledInterval({ ...base, exceptionRows: [exception("BLOCKS_ONLY", [{ kind: "WORKING", startMinute: 600, endMinute: 720 }])] }, startsAt, occupiedUntil), AvailabilityConfigurationError);
});
