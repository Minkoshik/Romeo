import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { readAdminToken, adminErrorResponse, adminJsonResponse } from "@/lib/admin-http";
import { getAdminCatalog, getAdminSchedule } from "@/lib/admin-catalog-repository";
import { getAdminAppointments } from "@/lib/admin-booking-repository";
import { getAdminManagement } from "@/lib/admin-management-repository";

const querySchema = z.object({ section: z.enum(["overview","catalog","schedule","appointments","customers","payments","settings","audit"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  masterId: z.uuid().optional(), status: z.string().max(32).optional(), search: z.string().max(120).optional(), id: z.uuid().optional(), needsAttention: z.enum(["true","false"]).optional(),
}).strict();
export async function GET(request: Request) {
  try {
    const token = readAdminToken(request); await getAdminSession(token);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const data = query.section === "catalog" ? await getAdminCatalog(token)
      : query.section === "schedule" ? await getAdminSchedule(token, query.masterId ?? "")
      : query.section === "appointments" ? await getAdminAppointments(token, { from: query.from ?? "", to: query.to ?? "", masterId: query.masterId, status: query.status })
      : await getAdminManagement(token, query.section, { from: query.from, to: query.to, search: query.search, id: query.id, status: query.status, needsAttention: query.needsAttention === "true" });
    return adminJsonResponse(data);
  } catch (error) { if (error instanceof z.ZodError) return Response.json({error:"Проверьте фильтры раздела."},{status:400,headers:{"Cache-Control":"no-store"}}); return adminErrorResponse(error); }
}
