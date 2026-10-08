import { processPaymentEvent } from "@/lib/payment-repository";
import { paymentErrorResponse, paymentHeaders, readPaymentBody } from "@/lib/payment-http";

export async function POST(request: Request) {
  try {
    const rawBody = await readPaymentBody(request);
    return Response.json(await processPaymentEvent(rawBody, request.headers.get("x-romeo-signature") ?? ""), { headers: paymentHeaders });
  } catch (error) { return paymentErrorResponse(error); }
}
