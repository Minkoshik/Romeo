import { getCountries, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import { z } from "zod";

const supportedCountries = new Set<string>(getCountries());

// Both the form and the quote endpoint apply the same contact rules.
export function createContactSchema(country: string) {
  const defaultCountry = supportedCountries.has(country.toUpperCase())
    ? country.toUpperCase() as CountryCode
    : undefined;

  return z.object({
    name: z.string({ error: "Введите имя" }).trim()
      .min(2, "Имя должно содержать хотя бы 2 символа")
      .max(80, "Имя должно содержать не больше 80 символов")
      .refine(value => /\p{L}/u.test(value), "Введите имя буквами")
      .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Уберите служебные символы из имени"),
    phone: z.string({ error: "Введите телефон" }).trim()
      .min(1, "Введите телефон")
      .max(40, "Телефон слишком длинный")
      .transform((value, context) => {
        const phone = parsePhoneNumberFromString(value, { defaultCountry, extract: false });
        if (!phone || !phone.isValid() || phone.ext) {
          context.addIssue({ code: "custom", message: "Введите корректный телефон; для другой страны используйте + и код страны" });
          return z.NEVER;
        }
        return phone.number;
      }),
    email: z.string({ error: "Введите email текстом" }).trim()
      .max(254, "Email слишком длинный")
      .refine(value => value === "" || z.email().safeParse(value).success, "Введите корректный email")
      .optional().default(""),
    comment: z.string({ error: "Введите комментарий текстом" }).trim()
      .max(1000, "Комментарий должен содержать не больше 1000 символов")
      .optional().default(""),
  }, { error: "Заполните контактные данные" });
}

export type ContactDetails = z.output<ReturnType<typeof createContactSchema>>;

export function contactFieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(error.issues.map(issue => [String(issue.path.at(-1) ?? "form"), issue.message]));
}
