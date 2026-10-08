export type BookingPolicy = {
  bookingHorizonDays: number; minimumLeadMinutes: number; slotStepMinutes: number;
  holdDurationMinutes: number; bufferMinutes: number;
  prepaymentMode: "DISABLED" | "FIXED" | "PERCENTAGE";
  prepaymentFixedMinor: number; prepaymentPercentage: number;
  bookingTerms: string; privacyTerms: string;
};
export type Salon = { name: string; address: string; phone: string; currency: string; timezone: string; country: string; policy: BookingPolicy };
export type Category = { id: string; slug?: string; name: string; description: string; isDemo?: boolean };
export type ServiceVariant = { id: string; name: string; priceMinor: number; durationMinutes: number; bufferMinutes?: number };
export type Service = { id: string; slug?: string; categoryId: string; name: string; description: string; details: string; popular?: boolean; isDemo?: boolean; variants: ServiceVariant[] };
export type Master = { id: string; slug?: string; name: string; specialty: string; description: string; initials: string; color: string; isDemo?: boolean; serviceIds: string[]; variantIds?: string[]; overrides?: Record<string, { priceMinor?: number; durationMinutes?: number; bufferMinutes?: number }> };
export type Catalog = { source: "demo" | "database"; isDemo?: boolean; salon?: Salon; categories: Category[]; services: Service[]; masters: Master[] };
export type ContactDetails = { name: string; phone: string; email: string; comment: string };
export type QuoteItem = { serviceId: string; variantId: string; serviceName: string; variantName: string; priceMinor: number; durationMinutes: number; bufferMinutes?: number };
export type DemoQuote = {
  source: "demo"; salon: Salon; master: Master; items: QuoteItem[];
  date: string; time: string; endsAtLocal: string; startsAt: string; endsAt: string;
  totalPriceMinor: number; totalDurationMinutes: number; totalBufferMinutes?: number; prepaymentMinor: number;
  remainingMinor: number; currency: string; contacts: ContactDetails;
};
export type DemoConfirmation = { source: "demo"; id: string; quote: DemoQuote; confirmedAt: string; paidMinor: number; paymentMode: "DEMO_SIMULATION"; paymentStatus: "DEMO_SUCCEEDED" | "NOT_REQUIRED" };
