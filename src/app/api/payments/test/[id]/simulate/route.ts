import { z } from "zod";
import { PaymentError, simulateTestPayment } from "@/lib/payment-repository";
import { checkPaymentOrigin, paymentBearerToken, paymentErrorResponse, paymentHeaders, readPaymentJson } from "@/lib/payment-http";

const inputSchema = z.object({ action: z.enum(["success", "fail", "cancel", "expire"]) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkPaymentOrigin(request);
    const token = paymentBearerToken(request); const { id } = await params;
    const parsed = inputSchema.safeParse(await readPaymentJson(request));
    if (!parsed.success) throw new PaymentError("Выберите результат тестовой оплаты.", 400);
    return Response.json(await simulateTestPayment(id, token, parsed.data.action), { headers: paymentHeaders });
  } catch (error) { return paymentErrorResponse(error); }
}
