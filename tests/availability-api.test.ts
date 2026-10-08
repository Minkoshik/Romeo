import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/availability/route";

const masterId = "550e8400-e29b-41d4-a716-446655440000";
const variantId = "550e8400-e29b-41d4-a716-446655440001";
const validSelection = `masterId=${masterId}&variantId=${variantId}`;

test("Availability API rejects malformed or client-supplied calculation parameters without leaking details", async () => {
  const queries = [
    "", `masterId=${masterId}`, `variantId=${variantId}`, `masterId=alex&variantId=${variantId}`,
    `masterId=${masterId}&variantId=mens-cut`, `${validSelection}&date=2026-02-30`,
    `${validSelection}&date=2026-2-03`, `${validSelection}&date=`,
    `${validSelection}&date=2026-10-07&date=2026-10-08`, `${validSelection}&masterId=${masterId}`,
    `${validSelection}&totalPriceMinor=1`, `${validSelection}&durationMinutes=1`, `${validSelection}&bufferMinutes=0`,
    `masterId=${masterId}&${Array.from({ length: 21 }, () => `variantId=${variantId}`).join("&")}`,
    `${validSelection}&date=${"x".repeat(4096)}`,
  ];
  for (const query of queries) {
    const response = await GET(new NextRequest(`http://localhost/api/availability?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.match(body.error, /[А-Яа-яЁё]/);
    assert.equal("slots" in body, false);
    assert.equal("stack" in body, false);
    assert.equal(JSON.stringify(body).includes("DATABASE_URL"), false);
  }
});
