import type { ContactDetails } from "./types";
import type { PaymentAvailability, PaymentView } from "./payment-types";

export type AppointmentStatus = "WAITING_PAYMENT" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW" | "EXPIRED";
export type AppointmentConditions = {
  totalPriceMinor: number; totalDurationMinutes: number; totalBufferMinutes: number;
  prepaymentRequiredMinor: number; currency: string; timezone: string;
  bookingTermsVersion: string; privacyTermsVersion: string;
};
export type CreateAppointmentInput = {
  variantIds: string[]; masterId: string; date: string; time: string;
  contacts: ContactDetails; consent: true; idempotencyKey: string; accessToken: string;
  expectedConditions?: AppointmentConditions;
};
export type AppointmentView = {
  source: "database"; id: string; number: number; status: AppointmentStatus;
  serverNow: string; createdAt: string; holdExpiresAt: string | null; confirmedAt: string | null;
  payments: PaymentView[]; paidMinor: number; remainingMinor: number; paymentAvailability: PaymentAvailability;
  details: {
    salonName: string; salonAddress: string; salonPhone: string; masterName: string;
    timezone: string; currency: string; startsAt: string; endsAt: string; occupiedUntil: string;
    totalPriceMinor: number; totalDurationMinutes: number; totalBufferMinutes: number; prepaymentRequiredMinor: number;
    items: { serviceName: string; variantName: string; priceMinor: number; durationMinutes: number; bufferMinutes: number }[];
    contacts: ContactDetails; bookingTerms: string; privacyTerms: string;
  };
};
