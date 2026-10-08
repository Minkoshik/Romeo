import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/demo/quote/route";
import { createContactSchema } from "../src/lib/contact-validation";
import { getDemoAvailability } from "../src/lib/demo-availability";
import { buildDemoQuote, calculatePrepaymentMinor, DemoQuoteError } from "../src/lib/demo-quote";
import { getSalon } from "../src/lib/salon";
import { demoCatalog } from "../src/lib/demo-catalog";

const salon = getSalon();
const now = new Date("2026-10-06T06:00:00.000Z");
const date = "2026-10-07";
function quoteOptions(masterId = "alex", durationMinutes = 60) { return { salon, catalog: demoCatalog, slots: getDemoAvailability({ date, masterId, durationMinutes, timezone: salon.timezone, policy: salon.policy, now }) }; }

const contacts = { name: "Мария", phone: "+7 (916) 123-45-67", email: "maria@example.com", comment: "" };

function requestFor(masterId = "alex", durationMinutes = 60) {
  const slot = getDemoAvailability({ date, masterId, durationMinutes, timezone: salon.timezone, policy: salon.policy, now }).find(item => item.status === "available");
  assert.ok(slot, "a future demo slot is available");
  return { variantIds: ["mens-cut-standard"], masterId, date, time: slot.time, contacts, consent: true };
}

test("quote ignores forged totals and uses the master's server price and duration", () => {
  const quote = buildDemoQuote({ ...requestFor("mark", 75), totalPriceMinor: 1, totalDurationMinutes: 1, prepaymentMinor: 0, paid: true }, quoteOptions("mark", 75));
  assert.equal(quote.source, "demo");
  assert.equal(quote.totalPriceMinor, 250000);
  assert.equal(quote.totalDurationMinutes, 75);
  assert.equal(quote.items[0].priceMinor, 250000);
  assert.equal(quote.contacts.phone, "+79161234567");
  assert.equal(quote.remainingMinor + quote.prepaymentMinor, quote.totalPriceMinor);
  assert.equal("paid" in quote, false);
});

test("quote rejects incompatible masters, unknown masters and repeated services", () => {
  const request = requestFor();
  assert.throws(() => buildDemoQuote({ ...request, variantIds: ["coloring-short"] }, quoteOptions()), (error: unknown) => error instanceof DemoQuoteError && error.fieldErrors?.masterId !== undefined);
  assert.throws(() => buildDemoQuote({ ...request, masterId: "nonexistent" }, quoteOptions()), DemoQuoteError);
  assert.throws(() => buildDemoQuote({ ...request, variantIds: ["mens-cut-standard", "mens-cut-standard"] }, quoteOptions()), /только один вариант/);
  assert.throws(() => buildDemoQuote({ ...requestFor("anna"), variantIds: ["coloring-short", "coloring-medium"] }, quoteOptions()), /только один вариант/);
});

test("quote requires consent and a valid whole available interval", () => {
  const request = requestFor();
  assert.throws(() => buildDemoQuote({ ...request, consent: false }, quoteOptions()), (error: unknown) => error instanceof DemoQuoteError && error.fieldErrors?.consent !== undefined);
  assert.throws(() => buildDemoQuote({ ...request, time: "23:59" }, quoteOptions()), (error: unknown) => error instanceof DemoQuoteError && error.status === 409);
  assert.throws(() => buildDemoQuote({ ...request, date: "2026-02-30" }, quoteOptions()), DemoQuoteError);
});

test("prepayment honors disabled, fixed and percentage policies and cannot exceed total", () => {
  assert.equal(calculatePrepaymentMinor(10000, { ...salon.policy, prepaymentMode: "DISABLED" }), 0);
  assert.equal(calculatePrepaymentMinor(10000, { ...salon.policy, prepaymentMode: "FIXED", prepaymentFixedMinor: 15000 }), 10000);
  assert.equal(calculatePrepaymentMinor(101, { ...salon.policy, prepaymentMode: "PERCENTAGE", prepaymentPercentage: 50 }), 51);
});

test("phone validation uses configured country while allowing explicit international numbers", () => {
  const ru = createContactSchema("RU");
  const us = createContactSchema("US");
  assert.equal(ru.parse({ ...contacts, phone: "8 (916) 123-45-67" }).phone, "+79161234567");
  assert.equal(us.parse({ ...contacts, phone: "202-555-0123" }).phone, "+12025550123");
  assert.equal(ru.safeParse({ ...contacts, phone: "202-555-0123" }).success, false);
  assert.equal(ru.parse({ ...contacts, phone: "+1 202-555-0123" }).phone, "+12025550123");
  assert.equal(ru.safeParse({ ...contacts, phone: "call +7 916 123 45 67" }).success, false);
  assert.equal(ru.safeParse({ ...contacts, phone: "+7 111 111 11 11" }).success, false);
  assert.equal(ru.safeParse({ ...contacts, email: "broken-email" }).success, false);
});

test("demo quote endpoint rejects oversized, malformed and non-JSON requests without caching", async () => {
  const malformed = await POST(new Request("http://localhost/api/demo/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await malformed.json(), { error: "Некорректный формат запроса" });
  const oversized = await POST(new Request("http://localhost/api/demo/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(16 * 1024 + 1) }));
  assert.equal(oversized.status, 413);
  const wrongType = await POST(new Request("http://localhost/api/demo/quote", { method: "POST", body: "{}" }));
  assert.equal(wrongType.status, 415);
});


