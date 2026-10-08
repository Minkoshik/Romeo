import { AppointmentError, getAppointment } from "@/lib/appointment-repository";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] ?? "";
  try {
    const { id } = await context.params;
    return Response.json(await getAppointment(id, token), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof AppointmentError ? error.message : "Запись временно недоступна. Повторите попытку." },
      { status: error instanceof AppointmentError ? error.status : 503, headers });
  }
}
