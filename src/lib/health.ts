import "server-only";
import { loadDatabaseCatalog } from "./catalog-repository";

export async function healthResponse(probe: () => Promise<unknown> = loadDatabaseCatalog): Promise<Response> {
  try {
    await probe();
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
