import assert from "node:assert/strict";
import test from "node:test";
import { buildAppointmentCalendar } from "../src/lib/appointment-calendar";
import type { AppointmentView } from "../src/lib/appointment-types";

const view: AppointmentView = {
  source: "database", id: "d1864c23-638f-41c3-8431-68bac136ec36", number: 42, status: "CONFIRMED",
  serverNow: "2026-10-07T08:00:00Z", createdAt: "2026-10-07T07:55:00Z", holdExpiresAt: null, confirmedAt: "2026-10-07T07:58:00Z",
  paymentAvailability: { mode: "TEST", canCreate: false }, paidMinor: 55000, remainingMinor: 165000,
  payments: [{ id: "b5071b60-ff61-408f-a34a-0b3262ce2417", appointmentId: "d1864c23-638f-41c3-8431-68bac136ec36", provider: "ROMEO_TEST", mode: "TEST", status: "SUCCEEDED", amountMinor: 55000, refundedAmountMinor: 0, currency: "RUB", createdAt: "2026-10-07T07:56:00Z", expiresAt: null, paidAt: "2026-10-07T07:58:00Z", needsAttention: false, attentionReason: null }],
  details: { salonName: "РОМЕО", salonAddress: "Москва, Большая Никитская, 22", salonPhone: "+7 (495) 000-00-00", masterName: "Марк",
    timezone: "Europe/Moscow", currency: "RUB", startsAt: "2026-10-08T10:00:00+03:00", endsAt: "2026-10-08T11:00:00+03:00", occupiedUntil: "2026-10-08T11:15:00+03:00",
    totalPriceMinor: 220000, totalDurationMinutes: 60, totalBufferMinutes: 15, prepaymentRequiredMinor: 55000,
    items: [{ serviceName: "Мужская стрижка", variantName: "Стандартная", priceMinor: 220000, durationMinutes: 60, bufferMinutes: 15 }],
    contacts: { name: "Личный клиент", phone: "+79161234567", email: "private@example.com", comment: "private comment" }, bookingTerms: "private terms", privacyTerms: "private privacy" },
};
const unfold = (calendar: string) => calendar.replace(/\r\n[ \t]/g, "");

test("appointment calendar exports confirmed snapshot moments, test label and no private contact data", () => {
  const calendar = unfold(buildAppointmentCalendar(view, new Date("2026-10-07T08:00:00Z")));
  assert.ok(calendar.includes("UID:d1864c23-638f-41c3-8431-68bac136ec36@romeo.local\r\n"));
  assert.ok(calendar.includes("DTSTART:20261008T070000Z\r\nDTEND:20261008T080000Z\r\n"));
  assert.ok(calendar.includes("SUMMARY:ТЕСТ: РОМЕО — визит\r\n"));
  assert.ok(calendar.includes("Деньги не списывались."));
  assert.ok(calendar.includes("STATUS:CONFIRMED\r\n"));
  for (const secret of Object.values(view.details.contacts)) assert.equal(calendar.includes(secret), false);
  assert.equal(calendar.includes("#token="), false);
  assert.equal(calendar.includes(view.details.bookingTerms), false);
});

test("appointment calendar refuses every unconfirmed status and labels no-payment confirmations correctly", () => {
  for (const status of ["WAITING_PAYMENT", "EXPIRED", "CANCELLED", "COMPLETED", "NO_SHOW"] as const) {
    assert.throws(() => buildAppointmentCalendar({ ...view, status }), /только подтверждённую/);
  }
  const calendar = unfold(buildAppointmentCalendar({ ...view, payments: [], paidMinor: 0 }));
  assert.ok(calendar.includes("SUMMARY:РОМЕО — визит\r\n"));
  assert.equal(calendar.includes("Подтверждено тестовым"), false);
});

test("appointment calendar escapes injected properties and folds Cyrillic by UTF-8 bytes", () => {
  const name = "Салон ✂️ ".repeat(30) + "; зал,\\1\r\nATTENDEE:injected";
  const calendar = buildAppointmentCalendar({ ...view, details: { ...view.details, salonName: name } });
  assert.equal(calendar.includes("\r\nATTENDEE:"), false);
  assert.ok(unfold(calendar).includes("\\; зал\\,\\\\1\\nATTENDEE:injected"));
  for (const line of calendar.trimEnd().split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  assert.equal(/(?<!\r)\n|\r(?!\n)/.test(calendar), false);
});
