import test from "node:test";
import assert from "node:assert/strict";
import { AdminError, hashAdminPassword, verifyAdminPassword } from "../src/lib/admin-auth";
import { ADMIN_COOKIE_NAME } from "../src/lib/admin-auth";
import { adminErrorResponse, adminSessionCookie, clearAdminSessionCookie, checkAdminOrigin, readAdminJson, readAdminToken } from "../src/lib/admin-http";
import { POST as loginPost } from "../src/app/api/admin/login/route";
import { POST as logoutPost } from "../src/app/api/admin/logout/route";
import { GET as sessionGet } from "../src/app/api/admin/session/route";
const origin = "http://127.0.0.1:3000";
const token = "A".repeat(43);
function request(body = "{}", headers: HeadersInit = {}) { return new Request(origin + "/api/admin/login", { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body }); }
test("Admin passwords use random salts and fixed strong scrypt; invalid or replaced hashes never authenticate", async () => {
  const password = "Тестовый пароль 2026!";
  const one = await hashAdminPassword(password); const two = await hashAdminPassword(password);
  assert.notEqual(one, two); assert.match(one, /^scrypt\$32768\$8\$1\$/);
  assert.ok(await verifyAdminPassword(password, one));
  assert.equal(await verifyAdminPassword(password + "x", one), false);
  assert.equal(await verifyAdminPassword(password, one.replace("32768", "1")), false);
  assert.equal(await verifyAdminPassword(password, "plain text"), false);
  await assert.rejects(() => hashAdminPassword("short"), AdminError);
});
test("Admin mutations require an exact same Origin, authority and fetch site before credentials or data", async () => {
  for (const supplied of [undefined, "null", "https://foreign.example", origin + "/", origin + "#hash", "http://user@127.0.0.1:3000"]) {
    const headers: Record<string, string> = { "content-type": "application/json" }; if (supplied) headers.origin = supplied;
    const response = await loginPost(new Request(origin + "/api/admin/login", { method: "POST", headers, body: "{}" }));
    assert.equal(response.status, 403); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.throws(() => checkAdminOrigin(request("{}", { "sec-fetch-site": "cross-site" })), AdminError);
  assert.doesNotThrow(() => checkAdminOrigin(new Request("http://localhost:3000/api/admin/login", { method: "POST", headers: { host: "127.0.0.1:3000", origin } })));
  const logout = await logoutPost(new Request(origin + "/api/admin/logout", { method: "POST" })); assert.equal(logout.status, 403);
});
test("Admin login validates bounded UTF-8 JSON and cannot accept injected role or bearer token", async () => {
  for (const body of ["{", "null", "[]", JSON.stringify({ email: "x@example.com", password: "password", role: "OWNER" })]) assert.equal((await loginPost(request(body))).status, 400);
  assert.equal((await loginPost(request("{}", { "content-type": "text/plain" }))).status, 415);
  assert.equal((await loginPost(request(JSON.stringify({ pad: "ж".repeat(9000) }), { "content-length": "1" }))).status, 413);
  await assert.rejects(() => readAdminJson(request(JSON.stringify({ pad: "a".repeat(20000) }))), (error: unknown) => error instanceof AdminError && error.status === 413);
  const large = JSON.stringify({ pad: "a".repeat(20000) }); assert.deepEqual(await readAdminJson(request(large), 192 * 1024), JSON.parse(large));
  await assert.rejects(() => readAdminJson(request(large), 999999));
});
test("Admin cookie is opaque, HttpOnly, strict and secure in production; duplicate or malformed tokens are rejected", async () => {
  const previous = process.env.APP_ENV;
  try {
    process.env.APP_ENV = "demo";
    const cookie = adminSessionCookie(token, new Date("2026-10-08T20:00:00Z"));
    assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Path=\//); assert.match(cookie, /Max-Age=28800/); assert.doesNotMatch(cookie, /Secure/);
    assert.equal(readAdminToken(new Request(origin, { headers: { cookie } })), token);
    for (const value of [`${ADMIN_COOKIE_NAME}=short`, `${ADMIN_COOKIE_NAME}=${token}; ${ADMIN_COOKIE_NAME}=${token}`, "another=" + token]) assert.equal(readAdminToken(new Request(origin, { headers: { cookie: value } })), null);
    const unauth = await sessionGet(new Request(origin + "/api/admin/session?token=" + token, { headers: { authorization: "Bearer " + token } }));
    assert.equal(unauth.status, 401); assert.equal(unauth.headers.get("cache-control"), "no-store");
    process.env.APP_ENV = "production";
    assert.match(adminSessionCookie(token, new Date()), /; Secure$/); assert.match(clearAdminSessionCookie(), /Max-Age=0/); assert.match(clearAdminSessionCookie(), /; Secure$/);
    assert.throws(() => checkAdminOrigin(request()), AdminError);
    assert.doesNotThrow(() => checkAdminOrigin(new Request("https://salon.example/api/admin/login", { headers: { origin: "https://salon.example" } })));
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});
test("Admin errors omit stacks, account fields, passwords, hashes and database credentials", async () => {
  const response = adminErrorResponse(new Error("DATABASE_URL=secret-password"));
  assert.equal(response.status, 503); const body = await response.text(); assert.doesNotMatch(body, /DATABASE_URL|secret-password|stack/);
  const limited = adminErrorResponse(new AdminError("Повторите позже.", 429)); assert.equal(limited.headers.get("retry-after"), "900");
});
