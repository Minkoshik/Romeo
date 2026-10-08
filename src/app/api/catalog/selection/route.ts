import { z } from "zod";
import { loadDatabaseCatalog, CatalogUnavailableError } from "@/lib/catalog-repository";
import { CatalogSelectionError, resolveCatalogSelection } from "@/lib/catalog-rules";

const headers = { "Cache-Control": "no-store" };
const selectionSchema = z.object({ variantIds: z.array(z.string().uuid()).min(1).max(20), masterId: z.string().uuid() });

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return Response.json({ error: "Отправьте данные в формате JSON" }, { status: 415, headers });
  // Small payloads only; an incrementally read body cannot bypass the size limit.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Выберите услуги и мастера" }, { status: 400, headers });
  let body = "";
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return Response.json({ error: "Запрос слишком большой" }, { status: 413, headers }); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch { return Response.json({ error: "Некорректный формат запроса" }, { status: 400, headers }); }
  finally { reader.releaseLock(); }
  let parsed;
  try { parsed = selectionSchema.safeParse(JSON.parse(body)); }
  catch { return Response.json({ error: "Некорректный формат запроса" }, { status: 400, headers }); }
  if (!parsed.success) return Response.json({ error: "Проверьте выбранные услуги и мастера" }, { status: 400, headers });
  try {
    const catalog = await loadDatabaseCatalog();
    const selection = resolveCatalogSelection(catalog, parsed.data.variantIds, parsed.data.masterId);
    return Response.json({ source: "database", ...selection, currency: catalog.salon!.currency }, { headers });
  } catch (error) {
    if (error instanceof CatalogSelectionError) return Response.json({ error: error.message, fieldErrors: error.fieldErrors }, { status: 400, headers });
    return Response.json({ error: error instanceof CatalogUnavailableError ? error.message : "Каталог временно недоступен. Повторите попытку." }, { status: 503, headers });
  }
}
