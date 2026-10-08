import "server-only";
import { PaymentError } from "./payment-repository";

export const paymentHeaders = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 16 * 1024;

export function checkPaymentOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin === null) return;
  let valid = false;
  try {
    const parsed = new URL(origin); const incoming = new URL(request.url);
    const authority = request.headers.get("host") ?? incoming.host;
    if (origin === parsed.origin && ["http:", "https:"].includes(parsed.protocol) && ["http:", "https:"].includes(incoming.protocol)
      && /^(?:\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority)) {
      valid = parsed.origin === new URL(`${incoming.protocol}//${authority}`).origin;
    }
  } catch { /* Malformed origin or authority is rejected. */ }
  if (!valid) throw new PaymentError("Платёж доступен только с этого сайта.", 403);
}

export function paymentBearerToken(request: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new PaymentError("Запись или платёж не найдены.", 404);
  return match[1];
}

export async function readPaymentBody(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new PaymentError("Отправьте данные в формате JSON.", 415);
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new PaymentError("Запрос слишком большой.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PaymentError("Заполните данные платежа.", 400);
  // Preserve a UTF-8 BOM as data too: signed callback verification must see
  // the exact incoming bytes rather than a decoder's BOM-stripped document.
  let size = 0; let content = ""; const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new PaymentError("Запрос слишком большой.", 413); }
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    throw new PaymentError("Некорректный формат запроса.", 400);
  } finally { reader.releaseLock(); }
}

export async function readPaymentJson(request: Request): Promise<unknown> {
  const content = await readPaymentBody(request);
  try { return JSON.parse(content); } catch { throw new PaymentError("Некорректный формат запроса.", 400); }
}

export function paymentErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof PaymentError ? error.message : "Платёж временно недоступен. Повторите попытку." },
    { status: error instanceof PaymentError ? error.status : 503, headers: paymentHeaders });
}
