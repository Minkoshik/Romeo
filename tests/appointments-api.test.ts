import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/appointments/route";
import { GET } from "../src/app/api/appointments/[id]/route";

const origin = "http://127.0.0.1:3000";
const endpoint = origin + "/api/appointments";
const id = "550e8400-e29b-41d4-a716-446655440000";
const token = "A".repeat(43);
async function publicError(response: Response, expectedStatus: number) {
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.error, /[А-Яа-яЁё]/);
  for (const key of ["id", "details", "stack", "database", "accessToken", "publicAccessTokenHash", "requestFingerprint"]) assert.equal(key in body, false);
  assert.equal(JSON.stringify(body).includes("DATABASE_URL"), false);
  return body;
}

test("Appointment POST rejects foreign or malformed origin before reading a booking", async () => {
  for (const value of ["https://foreign.example", "http://127.0.0.1:4000", "null", "invalid-origin",
    origin + "/extra", origin + "/", origin + "?query=x", origin + "#fragment", "http://user:password@127.0.0.1:3000"]) {
    await publicError(await POST(new Request(endpoint, { method: "POST", headers: { origin: value, "content-type": "application/json" }, body: "{}" })), 403);
  }
  const sameOriginHeaders: HeadersInit[] = [{ "content-type": "application/json", origin }, { "content-type": "application/json" }];
  for (const headers of sameOriginHeaders) {
    await publicError(await POST(new Request(endpoint, { method: "POST", headers, body: "{}" })), 400);
  }
  const internalEndpoint = "http://localhost:3000/api/appointments";
  await publicError(await POST(new Request(internalEndpoint, { method: "POST", headers: {
    "content-type": "application/json", host: "127.0.0.1:3000", origin,
  }, body: "{}" })), 400);
  await publicError(await POST(new Request(internalEndpoint, { method: "POST", headers: {
    "content-type": "application/json", host: "127.0.0.1:3000", origin: "http://127.0.0.1:4000",
  }, body: "{}" })), 403);
  for (const host of ["user@127.0.0.1:3000", "127.0.0.1:3000/extra", "127.0.0.1:3000,foreign.example", "127.0.0.1:65536", ""]) {
    await publicError(await POST(new Request(internalEndpoint, { method: "POST", headers: {
      "content-type": "application/json", host, origin, "x-forwarded-host": "127.0.0.1:3000",
    }, body: "{}" })), 403);
  }
  await publicError(await POST(new Request(internalEndpoint, { method: "POST", headers: {
    "content-type": "application/json", host: "foreign.example", origin, "x-forwarded-host": "127.0.0.1:3000",
  }, body: "{}" })), 403);
});

test("Appointment POST validates JSON, UTF-8, empty body and request structure without database writes", async () => {
  await publicError(await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })), 415);
  await publicError(await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" } })), 400);
  for (const body of ["{", "null", "[]", JSON.stringify({ idempotencyKey: "invalid", accessToken: token })]) {
    await publicError(await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body })), 400);
  }
  await publicError(await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" },
    body: new Uint8Array([0xc3, 0x28]) })), 400);
});

test("Appointment POST enforces 16 KiB actual bytes and streamed chunks despite forged Content-Length", async () => {
  await publicError(await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", "content-length": "16385" }, body: "{}" })), 413);
  const utf8Body = JSON.stringify({ padding: "ж".repeat(9000) });
  assert.ok(utf8Body.length < 16384 && Buffer.byteLength(utf8Body, "utf8") > 16384);
  await publicError(await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body: utf8Body })), 413);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(" ".repeat(8000)));
    controller.enqueue(new TextEncoder().encode(" ".repeat(9000)));
    controller.close();
  } });
  const streamedRequest = new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" },
    body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
  await publicError(await POST(streamedRequest), 413);
});

test("Appointment GET accepts a token only in Bearer header and hides malformed IDs identically", async () => {
  const errors: unknown[] = [];
  for (const authorization of [undefined, "", "Bearer short", "Basic " + token, "Bearer " + token + " extra"]) {
    const request = new Request(endpoint + "/" + id + "?accessToken=" + token, {
      headers: authorization === undefined ? {} : { authorization },
    });
    errors.push(await publicError(await GET(request, { params: Promise.resolve({ id }) }), 404));
  }
  errors.push(await publicError(await GET(new Request(endpoint + "/invalid", { headers: { authorization: "Bearer " + token } }),
    { params: Promise.resolve({ id: "invalid" }) }), 404));
  for (const error of errors) assert.deepEqual(error, { error: "Запись не найдена." });
});
