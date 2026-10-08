export type PaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED" | "PARTIALLY_REFUNDED" | "REFUNDED";
export type PaymentView = {
  id: string; appointmentId: string; provider: string; mode: "TEST" | "LIVE"; status: PaymentStatus;
  amountMinor: number; refundedAmountMinor: number; currency: string;
  createdAt: string; expiresAt: string | null; paidAt: string | null;
  needsAttention: boolean; attentionReason: string | null;
};
export type PaymentAvailability = { mode: "TEST" | "DISABLED"; canCreate: boolean; reason?: string };
export type TestPaymentAction = "success" | "fail" | "cancel" | "expire";
export type PaymentEventResult = { accepted: true; duplicate: boolean };

export const paymentViewSelect = { id: true, appointmentId: true, provider: true, mode: true, status: true, amountMinor: true, refundedAmountMinor: true,
  currency: true, createdAt: true, expiresAt: true, paidAt: true, needsAttention: true } as const;
export type PaymentViewRecord = Omit<PaymentView, "createdAt" | "expiresAt" | "paidAt" | "attentionReason"> & { createdAt: Date; expiresAt: Date | null; paidAt: Date | null };
export function toPaymentView(row: PaymentViewRecord): PaymentView {
  return { ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null, paidAt: row.paidAt?.toISOString() ?? null,
    attentionReason: row.needsAttention ? "Платёж требует проверки салоном. Свяжитесь с салоном для уточнения записи или возврата." : null };
}
