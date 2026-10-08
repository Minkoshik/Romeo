import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { adminCatalogMutationSchema, adminScheduleMutationSchema } from "../src/lib/admin-catalog-validation";

const key = () => randomUUID();
const masterId = randomUUID();
test("Admin catalogue validates strict fields, integer minor units, safe images and reference IDs", () => {
  const valid = { op: "variant.create", idempotencyKey: key(), data: { serviceId: key(), slug: "basic", name: " Основной ", priceMinor: 0, durationMinutes: 60, bufferMinutes: 15 } };
  const parsed = adminCatalogMutationSchema.parse(valid);
  assert.equal(parsed.op, "variant.create");
  if (parsed.op === "variant.create") assert.equal(parsed.data.name, "Основной");
  for (const input of [
    { ...valid, paid: true }, { ...valid, idempotencyKey: "bad" },
    { ...valid, data: { ...valid.data, priceMinor: -1 } }, { ...valid, data: { ...valid.data, priceMinor: 2.5 } },
    { ...valid, data: { ...valid.data, durationMinutes: 0 } }, { ...valid, data: { ...valid.data, bufferMinutes: -1 } },
    { ...valid, data: { ...valid.data, serviceId: "bad" } }, { ...valid, data: { ...valid.data, archivedAt: "2026-01-01" } },
  ]) assert.equal(adminCatalogMutationSchema.safeParse(input).success, false);
  const base = { op: "master.update", idempotencyKey: key(), id: masterId };
  for (const photoUrl of ["javascript:alert(1)", "//other.example/image", "http://other.example/image", "file:///secret"]) assert.equal(adminCatalogMutationSchema.safeParse({ ...base, data: { photoUrl } }).success, false);
  assert.equal(adminCatalogMutationSchema.safeParse({ ...base, data: { photoUrl: "/images/test.jpg" } }).success, true);
  assert.equal(adminCatalogMutationSchema.safeParse({ ...base, data: {} }).success, false);
});

test("Admin weekly schedule rejects overlap, invalid minutes and unknown fields", () => {
  const base = { op: "weekly", idempotencyKey: key(), masterId };
  assert.equal(adminScheduleMutationSchema.safeParse({ ...base, intervals: [{ dayOfWeek: 1, startMinute: 600, endMinute: 840 }, { dayOfWeek: 1, startMinute: 840, endMinute: 1200 }] }).success, true);
  assert.equal(adminScheduleMutationSchema.safeParse({ ...base, intervals: [] }).success, true);
  for (const intervals of [
    [{ dayOfWeek: 7, startMinute: 600, endMinute: 840 }], [{ dayOfWeek: 1, startMinute: 603, endMinute: 840 }],
    [{ dayOfWeek: 1, startMinute: 840, endMinute: 600 }], [{ dayOfWeek: 1, startMinute: -5, endMinute: 840 }],
    [{ dayOfWeek: 1, startMinute: 600, endMinute: 1445 }],
    [{ dayOfWeek: 1, startMinute: 600, endMinute: 840 }, { dayOfWeek: 1, startMinute: 800, endMinute: 900 }],
  ]) assert.equal(adminScheduleMutationSchema.safeParse({ ...base, intervals }).success, false);
  assert.equal(adminScheduleMutationSchema.safeParse({ ...base, intervals: [], force: true }).success, false);
});

test("Admin exception semantics distinguish closed days, replacement hours and blocked intervals", () => {
  const base = { op: "exception", idempotencyKey: key(), masterId, localDate: "2026-10-12", reason: "Отпуск" };
  const working = { kind: "WORKING", startMinute: 600, endMinute: 900 };
  const blocked = { kind: "BLOCKED", startMinute: 700, endMinute: 750 };
  for (const [kind, intervals] of [["CLOSED_DAY", []], ["REPLACE_DAY", [working, blocked]], ["BLOCKS_ONLY", [blocked]]] as const) assert.equal(adminScheduleMutationSchema.safeParse({ ...base, kind, intervals }).success, true);
  for (const [kind, intervals] of [["CLOSED_DAY", [blocked]], ["BLOCKS_ONLY", [working]], ["REPLACE_DAY", []], ["REPLACE_DAY", [blocked]]] as const) assert.equal(adminScheduleMutationSchema.safeParse({ ...base, kind, intervals }).success, false);
  assert.equal(adminScheduleMutationSchema.safeParse({ ...base, kind: "CLOSED_DAY", intervals: [], localDate: "2026-02-30" }).success, false);
});
