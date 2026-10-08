import { z } from "zod";
import { getCountries, type CountryCode } from "libphonenumber-js";
import type { Salon } from "./types";

// Только публичные настройки передаются в клиентский компонент.
export const salonSchema = z.object({
    name: z.string().trim().min(1).max(80), address: z.string().trim().min(1).max(200),
    phone: z.string().min(1).max(40), country: z.string().trim().toUpperCase().refine(value => getCountries().includes(value as CountryCode), "Некорректный код страны салона"),
    policy: z.object({
      bookingHorizonDays: z.coerce.number().int().min(1).max(365), minimumLeadMinutes: z.coerce.number().int().min(0).max(10080),
      slotStepMinutes: z.coerce.number().int().min(5).max(60), holdDurationMinutes: z.coerce.number().int().min(1).max(60), bufferMinutes: z.coerce.number().int().min(0).max(120),
      prepaymentMode: z.enum(["DISABLED", "FIXED", "PERCENTAGE"]), prepaymentFixedMinor: z.coerce.number().int().nonnegative().max(100000000), prepaymentPercentage: z.coerce.number().min(0).max(100),
      cancellationLeadMinutes: z.number().int().nonnegative().optional(), rescheduleLeadMinutes: z.number().int().nonnegative().optional(),
      bookingTerms: z.string().min(1).max(20000), privacyTerms: z.string().min(1).max(20000),
    }),
    currency: z.string().length(3).refine(value => { try { new Intl.NumberFormat("ru-RU", { style: "currency", currency: value }); return true; } catch { return false; } }, "Некорректная валюта салона"),
    timezone: z.string().refine(value => { try { new Intl.DateTimeFormat("ru-RU", { timeZone: value }); return true; } catch { return false; } }, "Некорректный часовой пояс салона"),
  });
export function getSalon(): Salon {
  return salonSchema.parse({ name: process.env.SALON_NAME ?? "РОМЕО", address: process.env.SALON_ADDRESS ?? "Москва, Большая Никитская, 22", phone: process.env.SALON_PHONE ?? "+7 (495) 000-00-00", currency: process.env.SALON_CURRENCY ?? "RUB", timezone: process.env.SALON_TIMEZONE ?? "Europe/Moscow", country: process.env.SALON_COUNTRY ?? "RU", policy: {
    bookingHorizonDays: process.env.BOOKING_HORIZON_DAYS ?? 60, minimumLeadMinutes: process.env.MINIMUM_LEAD_MINUTES ?? 120,
    slotStepMinutes: process.env.SLOT_STEP_MINUTES ?? 30, holdDurationMinutes: process.env.HOLD_DURATION_MINUTES ?? 10, bufferMinutes: process.env.BUFFER_MINUTES ?? 15,
    prepaymentMode: process.env.DEMO_PREPAYMENT_MODE ?? "PERCENTAGE", prepaymentFixedMinor: process.env.DEMO_PREPAYMENT_FIXED_MINOR ?? 50000, prepaymentPercentage: process.env.DEMO_PREPAYMENT_PERCENTAGE ?? 25,
    bookingTerms: process.env.BOOKING_TERMS ?? "Демонстрационные условия: салон и услуги вымышлены. Запись сохраняется в локальной базе. При требуемой предоплате время временно резервируется; без оплаты бронь автоматически истекает. Доступна только тестовая оплата без списания денег; успешный проверенный тестовый платёж подтверждает запись. Настоящий платёжный провайдер не подключён. Если предоплата не требуется, запись подтверждается сразу. Договор с настоящим салоном не заключается. Перед запуском салон должен подготовить свои условия записи, отмены и переноса.",
    privacyTerms: process.env.PRIVACY_TERMS ?? "Демонстрационный текст об обработке данных. Для проверки используйте вымышленные контакты. Черновик формы находится в памяти вкладки. Контакты передаются локальному серверу и при создании записи сохраняются в базе вместе с условиями визита. Просмотр доступен по личной ссылке. Перед настоящим запуском салон должен подготовить согласованные документы об обработке персональных данных.",
  } });
}
