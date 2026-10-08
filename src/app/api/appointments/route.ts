import { AppointmentError, createAppointment } from "@/lib/appointment-repository";

const headers = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 16 * 1024;

function sameOrigin(request: Request, origin: string): boolean {
  try {
    const parsedOrigin = new URL(origin);
    const requestUrl = new URL(request.url);
    // Browsers serialize Origin as a scheme and authority, without credentials,
    // paths, queries or fragments. Accept that complete serialized value only.
    if (origin !== parsedOrigin.origin || !["http:", "https:"].includes(parsedOrigin.protocol)
      || !["http:", "https:"].includes(requestUrl.protocol)) return false;
    // Next may use an internal localhost URL. The incoming Host retains the
    // browser's actual authority; forwarded-host headers are not trusted here.
    const authority = request.headers.get("host") ?? requestUrl.host;
    if (!/^(?:\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority)) return false;
    const target = new URL(`${requestUrl.protocol}//${authority}`);
    return parsedOrigin.origin === target.origin;
  } catch { return false; }
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppointmentError("Отправьте данные в формате JSON.", 415);
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new AppointmentError("Запрос слишком большой.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppointmentError("Заполните данные записи.", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0; let content = "";
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new AppointmentError("Запрос слишком большой.", 413); }
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode());
  } catch (error) {
    if (error instanceof AppointmentError) throw error;
    throw new AppointmentError("Некорректный формат запроса.", 400);
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== null && !sameOrigin(request, origin)) return Response.json({ error: "Создание записи доступно только с этого сайта." }, { status: 403, headers });
  try { return Response.json(await createAppointment(await readJson(request)), { status: 201, headers }); }
  catch (error) {
    return Response.json({ error: error instanceof AppointmentError ? error.message : "Запись временно недоступна. Повторите попытку.",
      ...(error instanceof AppointmentError && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) },
    { status: error instanceof AppointmentError ? error.status : 503, headers });
  }
}
