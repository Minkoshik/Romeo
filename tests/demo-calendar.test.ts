import assert from "node:assert/strict";
import test from "node:test";
import { buildDemoCalendar } from "../src/lib/demo-calendar";
import { demoMasters } from "../src/lib/demo-catalog";
import { getSalon } from "../src/lib/salon";
import type { DemoQuote } from "../src/lib/types";

const quote: DemoQuote = {
  source: "demo",
  salon: getSalon(),
  master: demoMasters[2],
  items: [{ serviceId: "mens-cut", variantId: "mens-cut-standard", serviceName: "Мужская стрижка", variantName: "Стандартная", priceMinor: 250000, durationMinutes: 75 }],
  date: "2026-10-07", time: "10:00", endsAtLocal: "11:15",
  startsAt: "2026-10-07T10:00:00+03:00", endsAt: "2026-10-07T11:15:00+03:00",
  totalPriceMinor: 250000, totalDurationMinutes: 75, prepaymentMinor: 62500,
  remainingMinor: 187500, currency: "RUB",
  contacts: { name: "Мария", phone: "+79161234567", email: "maria@example.com", comment: "" },
};
const now = new Date("2026-10-06T21:35:12.123+03:00");
const unfold = (calendar: string) => calendar.replace(/\r\n[ \t]/g, "");

test("calendar writes UTC moments and clearly marks the event as a demonstration", () => {
  const calendar = unfold(buildDemoCalendar(quote, "DEMO-123", now));
  assert.ok(calendar.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(calendar.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n"));
  assert.ok(calendar.includes("UID:DEMO-123@romeo.demo\r\n"));
  assert.ok(calendar.includes("DTSTAMP:20261006T183512Z\r\n"));
  assert.ok(calendar.includes("DTSTART:20261007T070000Z\r\n"));
  assert.ok(calendar.includes("DTEND:20261007T081500Z\r\n"));
  assert.ok(calendar.includes(`SUMMARY:ДЕМО: ${quote.salon.name} — визит\r\n`));
  assert.ok(calendar.includes("DESCRIPTION:Демонстрация: настоящая запись не создана."));
  assert.equal(calendar.includes(quote.contacts.phone), false);
  assert.equal(calendar.includes(quote.contacts.email), false);
});

test("calendar escapes text and prevents embedded line breaks from injecting properties", () => {
  const specialQuote = {
    ...quote,
    salon: { ...quote.salon, name: "Ромео; студия, зал\\1\r\nATTENDEE:injected", address: "Адрес\rдругая строка\nтретий этаж" },
  };
  const calendar = unfold(buildDemoCalendar(specialQuote, "DEMO;123,\\\r\nUID:injected", now));
  assert.ok(calendar.includes("SUMMARY:ДЕМО: Ромео\\; студия\\, зал\\\\1\\nATTENDEE:injected — визит\r\n"));
  assert.ok(calendar.includes("LOCATION:Адрес\\nдругая строка\\nтретий этаж\r\n"));
  assert.ok(calendar.includes("UID:DEMO\\;123\\,\\\\\\nUID:injected@romeo.demo\r\n"));
  assert.equal(calendar.includes("\r\nATTENDEE:"), false);
  assert.equal(calendar.match(/^UID:/gm)?.length, 1);
  assert.equal(/(?<!\r)\n|\r(?!\n)/.test(calendar), false);
});

test("UTF-8 folding preserves Cyrillic and emoji within 75-byte physical lines", () => {
  const longName = "Прекрасный салон ✂️💇 ".repeat(18);
  const calendar = buildDemoCalendar({ ...quote, salon: { ...quote.salon, name: longName } }, "DEMO-UTF8", now);
  const encoder = new TextEncoder();
  const lines = calendar.slice(0, -2).split("\r\n");
  assert.ok(lines.some(line => line.startsWith(" ")));
  for (const line of lines) {
    assert.ok(encoder.encode(line).length <= 75, "each physical line fits the UTF-8 byte limit");
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(line)), line);
  }
  assert.ok(unfold(calendar).includes(`SUMMARY:ДЕМО: ${longName} — визит\r\n`));
});
