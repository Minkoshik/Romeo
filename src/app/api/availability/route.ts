import { NextRequest } from "next/server";
import { loadDatabaseAvailability, AvailabilityRequestError, AvailabilityUnavailableError } from "@/lib/availability-repository";

const headers = { "Cache-Control": "no-store" };
const allowedKeys = new Set(["masterId", "variantId", "date"]);

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  if (request.nextUrl.search.length > 4096 || [...query.keys()].some(key => !allowedKeys.has(key))
    || query.getAll("masterId").length !== 1 || query.getAll("date").length > 1) {
    return Response.json({ error: "Некорректные параметры расписания." }, { status: 400, headers });
  }
  try {
    const result = await loadDatabaseAvailability({ masterId: query.get("masterId") ?? "", variantIds: query.getAll("variantId"),
      ...(query.has("date") ? { date: query.get("date") ?? "" } : {}) });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof AvailabilityRequestError) return Response.json({ error: error.message, fieldErrors: error.fieldErrors }, { status: 400, headers });
    return Response.json({ error: error instanceof AvailabilityUnavailableError ? error.message : "Расписание временно недоступно. Повторите попытку." }, { status: 503, headers });
  }
}
