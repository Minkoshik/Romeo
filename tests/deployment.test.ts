import test from "node:test";
import assert from "node:assert/strict";
import { assessDeployment } from "../src/lib/deployment-check";
import { healthResponse } from "../src/lib/health";
import { getSalon } from "../src/lib/salon";
import { demoCategories, demoMasters, demoServices } from "../src/lib/demo-catalog";
import { seedDemoCatalog, SeedConfigurationError } from "../prisma/seed";
import type { PrismaClient } from "../src/generated/prisma/client";
import type { Catalog } from "../src/lib/types";
import { adminCalendarRange } from "../src/lib/admin-calendar-range";

const catalog: Catalog = { source: "database", isDemo: true, salon: getSalon(), categories: demoCategories, services: demoServices, masters: demoMasters };
const environment = { APP_ENV: "demo", PAYMENT_MODE: "TEST", PAYMENT_WEBHOOK_SECRET: "0123456789abcdefghijklmnopqrstuv" };
test("Deployment rejects unpayable holds, missing owners and invalid environments without leaking secrets", () => {
  assert.equal(assessDeployment(catalog, true, environment).filter(i => i.level === "error").length, 0);
  assert.ok(assessDeployment(catalog, false, environment).some(i => i.level === "error"));
  assert.equal(assessDeployment(catalog, false, environment, true).filter(i => i.level === "error").length, 0);
  for (const env of [{ ...environment, PAYMENT_MODE: "DISABLED" }, { ...environment, APP_ENV: "production" }, { ...environment, PAYMENT_WEBHOOK_SECRET: "weak" }, { ...environment, APP_ENV: "unknown" }]) {
    const issues = assessDeployment(catalog, true, env);
    assert.ok(issues.some(i => i.level === "error"));
    assert.doesNotMatch(JSON.stringify(issues), /0123456789abcdefghijklmnopqrstuv|weak/);
  }
  assert.ok(assessDeployment({ ...catalog, salon: undefined, masters: [] }, true, environment).some(i => i.level === "error"));
});
test("Readiness probes return only a non-cacheable status for success, outages and missing migrations", async () => {
  const success = await healthResponse(async () => ({ private: "secret" }));
  assert.equal(success.status, 200); assert.equal(success.headers.get("cache-control"), "no-store");
  assert.deepEqual(await success.json(), { status: "ok" });
  const failure = await healthResponse(async () => { throw Error("postgresql://private-password/customer-name"); });
  assert.equal(failure.status, 503); assert.equal(failure.headers.get("cache-control"), "no-store");
  assert.deepEqual(await failure.json(), { status: "unavailable" });
});
test("Demo seed refuses APP_ENV=production before acquiring a transaction even without NODE_ENV", async () => {
  const previous = process.env.APP_ENV;
  try {
    process.env.APP_ENV = "production";
    let touched = false;
    const database = { $transaction: () => { touched = true; throw Error("must not execute"); } } as unknown as PrismaClient;
    await assert.rejects(() => seedDemoCatalog(database, getSalon()), SeedConfigurationError);
    assert.equal(touched, false);
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});
test("Admin calendar handles cleared dates without crashing and computes complete leap-month/week ranges", () => {
  for (const date of ["", "2026-02-30", "invalid", "9999-12-30"]) assert.equal(adminCalendarRange(date, "week"), null);
  assert.deepEqual(adminCalendarRange("2028-02-15", "month"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(adminCalendarRange("2026-12-29", "week"), { from: "2026-12-29", to: "2027-01-04" });
  assert.deepEqual(adminCalendarRange("2026-10-09", "day"), { from: "2026-10-09", to: "2026-10-09" });
});
