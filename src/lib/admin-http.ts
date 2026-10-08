import "server-only";
import { ADMIN_COOKIE_NAME, ADMIN_SESSION_SECONDS, AdminError } from "./admin-auth";

export const ADMIN_NO_STORE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const MAX_BODY_BYTES = 16 * 1024;
export function readAdminToken(request: Request): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(ADMIN_COOKIE_NAME + "="));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(ADMIN_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export function checkAdminOrigin(request: Request): void {
  try {
    const origin = request.headers.get("origin");
    if (!origin) throw new Error();
    const parsed = new URL(origin); const url = new URL(request.url);
    if (process.env.APP_ENV === "production" && url.protocol !== "https:") throw new Error();
    const host = request.headers.get("host") ?? url.host;
    if (origin !== parsed.origin || !["http:", "https:"].includes(parsed.protocol) || !["http:", "https:"].includes(url.protocol)
      || !/^(?:\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(host)
      || parsed.origin !== new URL(url.protocol + "//" + host).origin) throw new Error();
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") throw new Error();
  } catch { throw new AdminError("Операция доступна только с этого сайта.", 403); }
}
export async function readAdminJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 256 * 1024 ? maxBytes : MAX_BODY_BYTES;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AdminError("Отправьте данные в формате JSON.", 415);
  if (Number(request.headers.get("content-length")) > limit) throw new AdminError("Запрос слишком большой.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AdminError("Отправьте данные операции.", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0; let body = "";
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new AdminError("Запрос слишком большой.", 413); }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch (error) { if (error instanceof AdminError) throw error; throw new AdminError("Некорректный формат запроса.", 400); }
  finally { reader.releaseLock(); }
}
export function adminJsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...ADMIN_NO_STORE_HEADERS, ...extraHeaders } });
}
export function adminErrorResponse(error: unknown): Response {
  return adminJsonResponse({ error: error instanceof AdminError ? error.message : "Операция временно недоступна. Повторите попытку позже." }, error instanceof AdminError ? error.status : 503,
    error instanceof AdminError && error.status === 429 ? { "Retry-After": "900" } : {});
}
export function adminSessionCookie(token: string, expiresAt: Date): string {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SECONDS}; Expires=${expiresAt.toUTCString()}${process.env.APP_ENV === "production" ? "; Secure" : ""}`;
}
export function clearAdminSessionCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${process.env.APP_ENV === "production" ? "; Secure" : ""}`;
}
