import { getAdminSession } from "@/lib/admin-auth";
import { adminErrorResponse, adminJsonResponse, readAdminToken } from "@/lib/admin-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return adminJsonResponse({ admin: await getAdminSession(readAdminToken(request)) }); }
  catch (error) { return adminErrorResponse(error); }
}
