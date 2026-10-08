import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays, findNearestDemoSlot, getDemoAvailability, getDemoDateAvailability, salonDateString, salonDateTimeToInstant, type DemoAvailabilityInput } from "../src/lib/demo-availability";

const base: DemoAvailabilityInput = {
  date: "2026-10-07", masterId: "mark", durationMinutes: 60, timezone: "Europe/Moscow",
  now: new Date("2026-10-06T06:00:00Z"),
  policy: { bookingHorizonDays: 30, minimumLeadMinutes: 60, slotStepMinutes: 15, bufferMinutes: 15 },
};
const slot = (time: string, overrides: Partial<DemoAvailabilityInput> = {}) => getDemoAvailability({ ...base, ...overrides }).find(item => item.time === time)!;

test("full duration and technical buffer must not intersect another simulated appointment", () => {
  assert.equal(slot("10:45").status, "available"); // occupied interval ends exactly at 12:00
  assert.equal(slot("11:00").status, "busy"); // starts free, but the full visit crosses 12:00
  assert.equal(slot("11:00", { durationMinutes: 60, policy: { ...base.policy, bufferMinutes: 0 } }).status, "available");
  assert.equal(slot("12:00").status, "busy");
});

test("lunch and end-of-day rules include the buffer", () => {
  assert.equal(slot("13:00").reason, "Обеденный перерыв");
  assert.equal(slot("13:00", { durationMinutes: 45 }).status, "available");
  assert.equal(slot("14:30", { durationMinutes: 15 }).reason, "Обеденный перерыв");
  assert.equal(slot("18:45").status, "available");
  assert.equal(slot("19:00").reason, "Не успеем до закрытия");
  assert.equal(slot("18:00", { durationMinutes: 180 }).status, "closed");
});

test("slot instants are unambiguous UTC while labels remain salon wall time", () => {
  const result = slot("10:00");
  assert.equal(result.startAt, "2026-10-07T07:00:00.000Z");
  assert.equal(result.endAt, "2026-10-07T08:00:00.000Z");
  assert.equal(result.blockedUntil, "2026-10-07T08:15:00.000Z");
  assert.equal(result.endTime, "11:00");
});

test("minimum lead and elapsed slots are disabled with explanations", () => {
  const now = new Date("2026-10-07T07:30:00Z"); // salon 10:30
  assert.equal(slot("10:00", { now }).reason, "Уже прошло");
  assert.equal(slot("10:45", { now }).reason, "Слишком скоро");
  assert.equal(slot("11:30", { now, durationMinutes: 15 }).status, "available");
});

test("horizon is inclusive of today and cannot be bypassed", () => {
  const policy = { ...base.policy, bookingHorizonDays: 1 };
  assert.equal(slot("10:00", { date: "2026-10-06", policy }).status, "available");
  assert.equal(slot("10:00", { policy }).reason, "Вне горизонта записи");
  assert.equal(slot("10:00", { date: "2026-10-05", policy }).status, "past");
});

test("weekly closures, simulated holidays and master vacations cannot be selected", () => {
  assert.equal(slot("10:00", { date: "2026-10-11" }).reason, "Выходной салона");
  assert.equal(slot("10:00", { date: "2026-10-06", masterId: "alex" }).reason, "Выходной мастера");
  assert.equal(slot("10:00", { date: "2026-10-15" }).reason, "Отпуск мастера · демо");
  const holiday = { date: "2027-01-01", now: new Date("2026-12-31T06:00:00Z") };
  assert.equal(slot("10:00", holiday).reason, "Праздник · демо");
});

test("a long bundle has no dates when every possible start intersects busy time or lunch", () => {
  const input = { ...base, durationMinutes: 300 };
  assert.equal(getDemoDateAvailability(input).availableSlots, 0);
  assert.equal(findNearestDemoSlot(input), null);
});

test("nearest free action skips master day off and honors duration", () => {
  const nearest = findNearestDemoSlot({ ...base, masterId: "alex" });
  assert.equal(nearest?.date, "2026-10-07");
  assert.equal(nearest?.slot.time, "10:00");
  assert.equal(nearest?.slot.status, "available");
});

test("salon day and horizon do not change on a device in a different timezone", () => {
  const now = new Date("2026-10-06T22:30:00Z"); // Moscow October 7, device may still be October 6
  const saved = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const west = getDemoAvailability({ ...base, now });
    assert.equal(salonDateString(now, base.timezone), "2026-10-07");
    assert.equal(slot("10:00", { date: "2026-10-06", now }).status, "past");
    process.env.TZ = "Asia/Tokyo";
    assert.deepEqual(getDemoAvailability({ ...base, now }), west);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("nonexistent or ambiguous daylight-saving times are rejected", () => {
  assert.equal(salonDateTimeToInstant("2026-03-08", "02:30", "America/New_York"), null);
  assert.equal(salonDateTimeToInstant("2026-11-01", "01:30", "America/New_York"), null);
  assert.equal(salonDateTimeToInstant("2026-03-08", "01:30", "America/New_York")?.toISOString(), "2026-03-08T06:30:00.000Z");
  assert.equal(salonDateTimeToInstant("2026-10-07", "10:00", "Asia/Kathmandu")?.toISOString(), "2026-10-07T04:15:00.000Z");
});

test("invalid dates, master IDs, durations and off-grid times cannot become slots", () => {
  assert.deepEqual(getDemoAvailability({ ...base, date: "2026-02-30" }), []);
  assert.deepEqual(getDemoAvailability({ ...base, masterId: "someone-else" }), []);
  assert.deepEqual(getDemoAvailability({ ...base, durationMinutes: 0 }), []);
  assert.equal(getDemoAvailability(base).find(item => item.time === "10:07"), undefined);
  assert.equal(salonDateTimeToInstant("2026-02-30", "10:00", "Europe/Moscow"), null);
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
});
