import { logoutAdmin } from "@/lib/admin-auth";
import { adminErrorResponse, adminJsonResponse, checkAdminOrigin, clearAdminSessionCookie, readAdminToken } from "@/lib/admin-http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkAdminOrigin(request);
    await logoutAdmin(readAdminToken(request));
    return adminJsonResponse({ loggedOut: true }, 200, { "Set-Cookie": clearAdminSessionCookie() });
  } catch (error) { return adminErrorResponse(error); }
}
