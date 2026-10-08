import { createPayment } from "@/lib/payment-repository";
import { checkPaymentOrigin, paymentBearerToken, paymentErrorResponse, paymentHeaders, readPaymentJson } from "@/lib/payment-http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkPaymentOrigin(request);
    const token = paymentBearerToken(request); const { id } = await params;
    return Response.json(await createPayment(id, token, await readPaymentJson(request)), { status: 201, headers: paymentHeaders });
  } catch (error) { return paymentErrorResponse(error); }
}
