import { z } from "zod";
import { contactFieldErrors, createContactSchema } from "./contact-validation";
import { CatalogSelectionError, resolveCatalogSelection } from "./catalog-rules";
import type { AvailabilitySlot } from "./availability-types";
import { salonDateTimeToInstant } from "./salon-time";
import type { Catalog, DemoQuote, Salon } from "./types";

export type Quote = DemoQuote;
export type { QuoteItem } from "./types";

export class DemoQuoteError extends Error {
  constructor(message: string, public readonly status = 400, public readonly fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "DemoQuoteError";
  }
}

export function calculatePrepaymentMinor(totalPriceMinor: number, policy: Salon["policy"]): number {
  const amount = policy.prepaymentMode === "FIXED"
    ? policy.prepaymentFixedMinor
    : policy.prepaymentMode === "PERCENTAGE"
      ? Math.round(totalPriceMinor * policy.prepaymentPercentage / 100)
      : 0;
  return Math.max(0, Math.min(totalPriceMinor, amount));
}

// Every price and duration is loaded from the server catalog. Client totals are ignored.
export function buildDemoQuote(input: unknown, options: { salon: Salon; catalog: Catalog; slots: AvailabilitySlot[] }): Quote {
  const { salon, catalog, slots } = options;
  const schema = z.object({
    variantIds: z.array(z.string({ error: "Некорректная услуга" }).min(1, "Выберите услугу").max(100, "Некорректная услуга"), { error: "Выберите услуги" })
      .min(1, "Выберите хотя бы одну услугу").max(20, "Выбрано слишком много услуг"),
    masterId: z.string({ error: "Выберите мастера" }).min(1, "Выберите мастера").max(100, "Некорректный мастер"),
    date: z.string({ error: "Выберите дату" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Выберите корректную дату"),
    time: z.string({ error: "Выберите время" }).regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Выберите корректное время"),
    contacts: createContactSchema(salon.country),
    consent: z.literal(true, { error: "Подтвердите согласие с условиями записи и обработкой данных" }),
  }, { error: "Заполните данные записи" });
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new DemoQuoteError("Проверьте выбранные услуги и контактные данные", 400, contactFieldErrors(parsed.error));
  }
  const request = parsed.data;
  let selection;
  try { selection = resolveCatalogSelection({ ...catalog, salon }, request.variantIds, request.masterId); }
  catch (error) {
    if (error instanceof CatalogSelectionError) throw new DemoQuoteError(error.message, 400, error.fieldErrors);
    throw error;
  }
  const { master, items, totalPriceMinor, totalDurationMinutes, totalBufferMinutes } = selection;
  const instant = salonDateTimeToInstant(request.date, request.time, salon.timezone);
  const slot = slots.find(item => item.time === request.time && item.status === "available" && instant?.toISOString() === item.startAt
    && Date.parse(item.endAt) - Date.parse(item.startAt) === totalDurationMinutes * 60000
    && Date.parse(item.blockedUntil) - Date.parse(item.endAt) === totalBufferMinutes * 60000);
  if (!slot) throw new DemoQuoteError("Это время недоступно. Выберите другой интервал", 409, { time: "Выберите свободное время" });

  const prepaymentMinor = calculatePrepaymentMinor(totalPriceMinor, salon.policy);
  return {
    source: "demo",
    salon,
    master,
    items,
    date: request.date,
    time: request.time,
    endsAtLocal: slot.endTime,
    startsAt: slot.startAt,
    endsAt: slot.endAt,
    totalPriceMinor,
    totalDurationMinutes,
    totalBufferMinutes,
    prepaymentMinor,
    remainingMinor: totalPriceMinor - prepaymentMinor,
    currency: salon.currency,
    contacts: request.contacts,
  };
}
