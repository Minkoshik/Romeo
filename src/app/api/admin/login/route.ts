import { loginAdmin } from "@/lib/admin-auth";
import { adminErrorResponse, adminJsonResponse, adminSessionCookie, checkAdminOrigin, readAdminJson } from "@/lib/admin-http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkAdminOrigin(request);
    const session = await loginAdmin(await readAdminJson(request));
    return adminJsonResponse({ admin: session.admin }, 200, { "Set-Cookie": adminSessionCookie(session.token, session.expiresAt) });
  } catch (error) { return adminErrorResponse(error); }
}
