import { buildDemoQuote, DemoQuoteError } from "@/lib/demo-quote";
import { z } from "zod";
import { CatalogUnavailableError } from "@/lib/catalog-repository";
import { loadDatabaseAvailabilityContext, AvailabilityRequestError, AvailabilityUnavailableError } from "@/lib/availability-repository";

const MAX_BODY_BYTES = 16 * 1024;
const responseHeaders = { "Cache-Control": "no-store" };
const identifiersSchema = z.object({ variantIds: z.array(z.string().uuid()).min(1).max(20), masterId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) });

class RequestBodyError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function readSmallJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestBodyError("Отправьте данные в формате JSON", 415);
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) throw new RequestBodyError("Запрос слишком большой", 413);
  if (!request.body) throw new RequestBodyError("Заполните данные записи", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestBodyError("Запрос слишком большой", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyError("Некорректный формат запроса", 400);
  }
}

// Stateless demo calculation: contacts are returned only to this request, never saved.
export async function POST(request: Request) {
  try {
    const input = await readSmallJson(request);
    const selection = identifiersSchema.safeParse(input);
    if (!selection.success) return Response.json({ error: "Проверьте выбранные услуги, мастера, дату и время" }, { status: 400, headers: responseHeaders });
    const { catalog, availability } = await loadDatabaseAvailabilityContext(selection.data);
    return Response.json(buildDemoQuote(input, { salon: catalog.salon!, catalog, slots: availability.slots }), { headers: responseHeaders });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return Response.json({ error: error.message }, { status: 503, headers: responseHeaders });
    if (error instanceof AvailabilityUnavailableError) return Response.json({ error: error.message }, { status: 503, headers: responseHeaders });
    if (error instanceof AvailabilityRequestError) return Response.json({ error: error.message }, { status: 400, headers: responseHeaders });
    if (error instanceof DemoQuoteError) {
      return Response.json({ error: error.message, fieldErrors: error.fieldErrors }, { status: error.status, headers: responseHeaders });
    }
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status, headers: responseHeaders });
    }
    return Response.json({ error: "Не удалось рассчитать запись. Попробуйте ещё раз" }, { status: 500, headers: responseHeaders });
  }
}
