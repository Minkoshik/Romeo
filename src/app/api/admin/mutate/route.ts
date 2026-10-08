import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { readAdminToken, checkAdminOrigin, readAdminJson, adminErrorResponse, adminJsonResponse } from "@/lib/admin-http";
import { mutateAdminCatalog, mutateAdminSchedule } from "@/lib/admin-catalog-repository";
import { mutateAdminAppointment } from "@/lib/admin-booking-repository";
import { mutateAdminManagement } from "@/lib/admin-management-repository";

const schema = z.object({ target: z.enum(["catalog","schedule","appointment","management"]), input: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    checkAdminOrigin(request); const token = readAdminToken(request); await getAdminSession(token);
    const {target,input} = schema.parse(await readAdminJson(request,192*1024));
    const result = target === "catalog" ? await mutateAdminCatalog(token,input)
      : target === "schedule" ? await mutateAdminSchedule(token,input)
      : target === "appointment" ? await mutateAdminAppointment(token,input)
      : await mutateAdminManagement(token,input);
    return adminJsonResponse(result);
  } catch (error) { if (error instanceof z.ZodError) return Response.json({error:"Проверьте поля операции."},{status:400,headers:{"Cache-Control":"no-store"}}); return adminErrorResponse(error); }
}
