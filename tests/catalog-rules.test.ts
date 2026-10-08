import assert from "node:assert/strict";
import test from "node:test";
import { CatalogSelectionError, masterCanPerform, resolveCatalogSelection } from "../src/lib/catalog-rules";
import type { Catalog } from "../src/lib/types";

function catalog(): Catalog {
  return {
    source: "database", categories: [],
    services: [{ id: "color", categoryId: "color-category", name: "Окрашивание", description: "", details: "", variants: [
      { id: "short", name: "Короткие", priceMinor: 480000, durationMinutes: 120 },
      { id: "long", name: "Длинные", priceMinor: 820000, durationMinutes: 180 },
    ] }],
    masters: [{ id: "anna", name: "Анна", specialty: "", description: "", initials: "А", color: "rose", serviceIds: ["color"], variantIds: ["short"] }],
  };
}

test("a master's service assignment does not grant unassigned variants of that service", () => {
  const data = catalog();
  assert.equal(masterCanPerform(data.masters[0], [{ serviceId: "color", variantId: "short" }]), true);
  assert.equal(masterCanPerform(data.masters[0], [{ serviceId: "color", variantId: "long" }]), false);
  assert.equal(masterCanPerform(data.masters[0], []), false);
  assert.throws(() => resolveCatalogSelection(data, ["long"], "anna"), (error: unknown) => error instanceof CatalogSelectionError && Boolean(error.fieldErrors?.masterId));
  assert.equal(resolveCatalogSelection(data, ["short"], "anna").totalPriceMinor, 480000);
});

test("selection rejects vanished identifiers, duplicated variants and two variants of one service", () => {
  const data = catalog();
  assert.throws(() => resolveCatalogSelection(data, ["short"], "missing"), CatalogSelectionError);
  assert.throws(() => resolveCatalogSelection(data, ["missing"], "anna"), CatalogSelectionError);
  assert.throws(() => resolveCatalogSelection(data, ["short", "short"], "anna"), /только один вариант/);
  assert.throws(() => resolveCatalogSelection(data, ["short", "long"], "anna"), /только один вариант/);
  assert.throws(() => resolveCatalogSelection(data, [], "anna"), CatalogSelectionError);
});

test("a zero individual price is respected while absent overrides inherit catalog amounts", () => {
  const data = catalog();
  data.masters[0].overrides = { short: { priceMinor: 0, durationMinutes: 150 } };
  const free = resolveCatalogSelection(data, ["short"], "anna");
  assert.equal(free.totalPriceMinor, 0);
  assert.equal(free.totalDurationMinutes, 150);
  assert.equal(free.items[0].priceMinor, 0);
  data.masters[0].overrides = { short: { durationMinutes: 90 } };
  const inherited = resolveCatalogSelection(data, ["short"], "anna");
  assert.equal(inherited.totalPriceMinor, 480000);
  assert.equal(inherited.totalDurationMinutes, 90);
});

test("database masters with an explicit empty assignment list cannot fall back to services", () => {
  const data = catalog();
  data.masters[0].variantIds = [];
  assert.equal(masterCanPerform(data.masters[0], [{ serviceId: "color", variantId: "short" }]), false);
  assert.throws(() => resolveCatalogSelection(data, ["short"], "anna"), CatalogSelectionError);
});
