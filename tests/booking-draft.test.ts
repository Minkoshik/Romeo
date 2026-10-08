import assert from "node:assert/strict";
import test from "node:test";
import { bookingDraftReducer, emptyDraft, type BookingDraft } from "../src/lib/booking-draft";
import { demoCatalog } from "../src/lib/demo-catalog";
import type { DemoConfirmation, DemoQuote, Salon } from "../src/lib/types";

const contacts = { name: "Мария", phone: "+79161234567", email: "maria@example.com", comment: "Лёгкая укладка" };
const salon: Salon = {
  name: "РОМЕО", address: "Москва", phone: "+74950000000", country: "RU", currency: "RUB", timezone: "Europe/Moscow",
  policy: { bookingHorizonDays: 30, minimumLeadMinutes: 60, slotStepMinutes: 15, holdDurationMinutes: 10,
    bufferMinutes: 15, prepaymentMode: "PERCENTAGE", prepaymentFixedMinor: 0, prepaymentPercentage: 30,
    bookingTerms: "Демонстрация", privacyTerms: "Демонстрация" },
};
const quote: DemoQuote = {
  source: "demo", salon, master: demoCatalog.masters[0],
  items: [{ serviceId: "mens-cut", variantId: "mens-cut-standard", serviceName: "Мужская стрижка", variantName: "Стандартная", priceMinor: 220000, durationMinutes: 60 }],
  date: "2026-10-07", time: "10:00", endsAtLocal: "11:00", startsAt: "2026-10-07T07:00:00.000Z", endsAt: "2026-10-07T08:00:00.000Z",
  totalPriceMinor: 220000, totalDurationMinutes: 60, prepaymentMinor: 66000, remainingMinor: 154000, currency: "RUB", contacts,
};
const receipt: DemoConfirmation = { source: "demo", id: "DEMO-FIRST", quote, confirmedAt: "2026-10-06T18:00:00.000Z", paidMinor: 66000, paymentMode: "DEMO_SIMULATION", paymentStatus: "DEMO_SUCCEEDED" };

test("refreshing an archived catalog removes unavailable choices and stale quote while preserving contacts", () => {
  const before = populatedDraft({ receipt });
  const catalog = { ...demoCatalog, services: demoCatalog.services.filter(service => service.id !== "mens-cut") };
  const after = bookingDraftReducer(before, { type: "refresh", catalog });
  assert.deepEqual(after.variantIds, []);
  assert.equal(after.masterId, null);
  assert.equal(after.date, null);
  assert.equal(after.time, null);
  assert.equal(after.quote, null);
  assert.equal(after.payment, null);
  assert.equal(after.receipt, null);
  assert.deepEqual(after.contacts, contacts);
  assert.match(after.notice ?? "", /Каталог обновлён/);
});

function populatedDraft(overrides: Partial<BookingDraft> = {}): BookingDraft {
  return { ...emptyDraft, variantIds: ["mens-cut-standard"], masterId: "alex", date: quote.date, time: quote.time,
    contacts, consent: true, quote, payment: { mode: "DEMO_SIMULATION", status: "pending", expiresAt: 1_791_316_200_000, attempts: 0 }, revision: 7, ...overrides };
}

function assertDownstreamInvalidated(draft: BookingDraft, revision: number) {
  assert.equal(draft.quote, null);
  assert.equal(draft.payment, null);
  assert.equal(draft.receipt, null);
  assert.ok(draft.revision > revision);
}

test("changing services retains a compatible master but requires a fresh date, time and quote", () => {
  const before = populatedDraft({ receipt });
  const after = bookingDraftReducer(before, { type: "services", variantIds: ["mens-cut-standard", "beard-model-standard"], catalog: demoCatalog });
  assert.equal(after.masterId, "alex");
  assert.deepEqual(after.variantIds, ["mens-cut-standard", "beard-model-standard"]);
  assert.equal(after.date, null);
  assert.equal(after.time, null);
  assertDownstreamInvalidated(after, before.revision);
  assert.deepEqual(after.contacts, contacts);
});

test("an incompatible service clears master, date and time with a useful explanation", () => {
  const before = populatedDraft();
  const after = bookingDraftReducer(before, { type: "services", variantIds: ["coloring-short"], catalog: demoCatalog });
  assert.equal(after.masterId, null);
  assert.equal(after.date, null);
  assert.equal(after.time, null);
  assert.match(after.notice ?? "", /мастер не подходит/);
  assertDownstreamInvalidated(after, before.revision);
  const cleared = bookingDraftReducer(before, { type: "services", variantIds: [], catalog: demoCatalog });
  assert.equal(cleared.masterId, null);
});

test("changing the master invalidates dependent choices, while selecting the same master preserves them", () => {
  const before = populatedDraft();
  assert.equal(bookingDraftReducer(before, { type: "master", masterId: "alex" }), before);
  const after = bookingDraftReducer(before, { type: "master", masterId: "mark" });
  assert.equal(after.masterId, "mark");
  assert.equal(after.date, null);
  assert.equal(after.time, null);
  assert.deepEqual(after.variantIds, before.variantIds);
  assertDownstreamInvalidated(after, before.revision);
});

test("changing date clears only its dependent time and payment; changing time preserves the date", () => {
  const before = populatedDraft();
  assert.equal(bookingDraftReducer(before, { type: "date", date: quote.date }), before);
  assert.equal(bookingDraftReducer(before, { type: "time", time: quote.time }), before);
  const changedDate = bookingDraftReducer(before, { type: "date", date: "2026-10-08" });
  assert.equal(changedDate.date, "2026-10-08");
  assert.equal(changedDate.time, null);
  assert.equal(changedDate.masterId, "alex");
  assertDownstreamInvalidated(changedDate, before.revision);
  const changedTime = bookingDraftReducer(before, { type: "time", time: "10:15" });
  assert.equal(changedTime.time, "10:15");
  assert.equal(changedTime.date, quote.date);
  assertDownstreamInvalidated(changedTime, before.revision);
});

test("contacts and consent survive return-and-edit choices, but their edit requires a fresh quote", () => {
  let draft = bookingDraftReducer(populatedDraft(), { type: "contacts", contacts: { ...contacts, name: "Марина" }, consent: true });
  assert.equal(draft.contacts.name, "Марина");
  assert.equal(draft.quote, null);
  assert.equal(draft.payment, null);
  draft = bookingDraftReducer(draft, { type: "master", masterId: "anna" });
  draft = bookingDraftReducer(draft, { type: "date", date: "2026-10-09" });
  draft = bookingDraftReducer(draft, { type: "time", time: "15:00" });
  assert.equal(draft.contacts.name, "Марина");
  assert.equal(draft.contacts.phone, contacts.phone);
  assert.equal(draft.consent, true);
});

test("an old asynchronous server quote cannot overwrite a newer draft revision", () => {
  const before = populatedDraft();
  const edited = bookingDraftReducer(before, { type: "time", time: "10:15" });
  const late = bookingDraftReducer(edited, { type: "quote", quote, revision: before.revision });
  assert.equal(late, edited);
  assert.equal(late.quote, null);
  const currentQuote = { ...quote, time: "10:15" };
  const accepted = bookingDraftReducer(edited, { type: "quote", quote: currentQuote, revision: edited.revision });
  assert.equal(accepted.quote, currentQuote);
  assert.equal(accepted.payment, null);
});

test("confirmation requires a quote and successful simulation whenever prepayment is due", () => {
  const noQuote = populatedDraft({ quote: null });
  assert.equal(bookingDraftReducer(noQuote, { type: "confirm", receipt }), noQuote);
  const noPayment = populatedDraft({ payment: null });
  assert.equal(bookingDraftReducer(noPayment, { type: "confirm", receipt }), noPayment);
  for (const status of ["pending", "error", "cancel", "expired"] as const) {
    const draft = populatedDraft({ payment: { mode: "DEMO_SIMULATION", status, expiresAt: 1_791_316_200_000, attempts: 1 } });
    assert.equal(bookingDraftReducer(draft, { type: "confirm", receipt }), draft, status);
  }
  const successful = populatedDraft({ payment: { mode: "DEMO_SIMULATION", status: "success", expiresAt: 1_791_316_200_000, attempts: 1 } });
  assert.equal(bookingDraftReducer(successful, { type: "confirm", receipt }).receipt, receipt);
});

test("confirmation without required prepayment succeeds, and a second confirmation cannot replace its number", () => {
  const freeQuote = { ...quote, prepaymentMinor: 0, remainingMinor: quote.totalPriceMinor };
  const freeReceipt: DemoConfirmation = { ...receipt, quote: freeQuote, paidMinor: 0, paymentStatus: "NOT_REQUIRED" };
  const confirmed = bookingDraftReducer(populatedDraft({ quote: freeQuote, payment: null }), { type: "confirm", receipt: freeReceipt });
  assert.equal(confirmed.receipt, freeReceipt);
  const repeated = bookingDraftReducer(confirmed, { type: "confirm", receipt: { ...freeReceipt, id: "DEMO-SECOND" } });
  assert.equal(repeated, confirmed);
  assert.equal(repeated.receipt?.id, "DEMO-FIRST");
  const latePayment = bookingDraftReducer(confirmed, { type: "payment", payment: { mode: "DEMO_SIMULATION", status: "error", expiresAt: 1_791_316_200_000, attempts: 1 } });
  assert.equal(latePayment, confirmed);
});

test("starting a new demo clears personal data and makes every prior quote stale", () => {
  const before = populatedDraft({ receipt });
  const reset = bookingDraftReducer(before, { type: "reset" });
  assert.deepEqual(reset.variantIds, []);
  assert.equal(reset.masterId, null);
  assert.equal(reset.date, null);
  assert.equal(reset.time, null);
  assert.deepEqual(reset.contacts, emptyDraft.contacts);
  assert.equal(reset.consent, false);
  assertDownstreamInvalidated(reset, before.revision);
  assert.equal(bookingDraftReducer(reset, { type: "quote", quote, revision: before.revision }), reset);
});
