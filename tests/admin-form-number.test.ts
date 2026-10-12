import assert from "node:assert/strict";
import test from "node:test";
import { adminFormNumber } from "../src/lib/admin-form-number";

test("Admin form distinguishes an empty override, zero and prices with minor units", () => {
  assert.equal(adminFormNumber("", { emptyAsNull: true, scale: 100 }), null);
  assert.equal(adminFormNumber("0", { emptyAsNull: true, scale: 100 }), 0);
  assert.equal(adminFormNumber("1250.50", { scale: 100 }), 125050);
  assert.equal(adminFormNumber("100.10", { scale: 100 }), 10010);
  assert.equal(adminFormNumber("-5"), -5);
});

test("Invalid optional overrides cannot silently become null in a JSON request", () => {
  for (const value of ["abc", "NaN", "Infinity", "1e999", "9007199254740992"]) {
    assert.throws(() => adminFormNumber(value, { emptyAsNull: true }), /корректное число/);
  }
});

test("Admin form rejects fractional minutes and fractions below a currency minor unit", () => {
  assert.throws(() => adminFormNumber("30.5"), /корректное число/);
  assert.throws(() => adminFormNumber("1.999", { scale: 100 }), /корректное число/);
});
