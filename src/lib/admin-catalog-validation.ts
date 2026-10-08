import { z } from "zod";
import { validCalendarDate } from "./salon-time";

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const name = z.string().trim().min(1).max(200);
const text = z.string().trim().max(4000);
const slug = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const sort = z.number().int().min(-10000).max(10000);
const money = z.number().int().min(0).max(100_000_000);
const duration = z.number().int().min(1).max(1440);
const buffer = z.number().int().min(0).max(1440);
const image = z.string().trim().max(2048).refine(value => /^\/(?!\/)/.test(value) || /^https:\/\/[^\s]+$/.test(value), "Укажите локальный путь или HTTPS-ссылку").nullable();

const category = z.object({ slug, name, description: text.nullable().optional(), sortOrder: sort.optional(), isActive: z.boolean().optional(), isDemo: z.boolean().optional() }).strict();
const service = z.object({ categoryId: uuid, slug, name, shortDescription: text, detailedDescription: text.nullable().optional(), imageUrl: image.optional(), sortOrder: sort.optional(), isFeatured: z.boolean().optional(), isActive: z.boolean().optional(), isDemo: z.boolean().optional() }).strict();
const variant = z.object({ serviceId: uuid, slug, name, priceMinor: money, durationMinutes: duration, bufferMinutes: buffer.optional(), sortOrder: sort.optional(), isActive: z.boolean().optional() }).strict();
const master = z.object({ slug, name, specialization: name, description: text, photoUrl: image.optional(), sortOrder: sort.optional(), isBookable: z.boolean().optional(), isDemo: z.boolean().optional() }).strict();
const assignment = z.object({ masterId: uuid, serviceVariantId: uuid, priceMinorOverride: money.nullable().optional(), durationMinutesOverride: duration.nullable().optional(), bufferMinutesOverride: buffer.nullable().optional(), isActive: z.boolean().optional() }).strict();
const base = { idempotencyKey: uuid };
function update<T extends string, S extends z.ZodObject>(op: T, schema: S) {
  return z.object({ ...base, op: z.literal(op), id: uuid, data: schema.partial().refine(value => Object.keys(value).length > 0, "Укажите изменения") }).strict();
}
function archive<T extends string>(op: T) { return z.object({ ...base, op: z.literal(op), id: uuid }).strict(); }

export const adminCatalogMutationSchema = z.discriminatedUnion("op", [
  z.object({ ...base, op: z.literal("category.create"), data: category }).strict(), update("category.update", category), archive("category.archive"),
  z.object({ ...base, op: z.literal("service.create"), data: service }).strict(), update("service.update", service), archive("service.archive"),
  z.object({ ...base, op: z.literal("variant.create"), data: variant }).strict(), update("variant.update", variant), archive("variant.archive"),
  z.object({ ...base, op: z.literal("master.create"), data: master }).strict(), update("master.update", master), archive("master.archive"),
  z.object({ ...base, op: z.literal("assignment.upsert"), data: assignment }).strict(), archive("assignment.archive"),
]);

const minute = z.number().int().min(0).max(1440).refine(value => value % 5 === 0, "Время должно быть кратно пяти минутам");
const interval = z.object({ startMinute: minute, endMinute: minute });
const weekly = interval.extend({ dayOfWeek: z.number().int().min(0).max(6) }).strict();
const exceptionInterval = interval.extend({ kind: z.enum(["WORKING", "BLOCKED"]) }).strict();
const date = z.string().refine(validCalendarDate, "Укажите корректную календарную дату");
const scheduleBase = { ...base, masterId: uuid };
export const adminScheduleMutationSchema = z.discriminatedUnion("op", [
  z.object({ ...scheduleBase, op: z.literal("weekly"), intervals: z.array(weekly).max(42) }).strict(),
  z.object({ ...scheduleBase, op: z.literal("exception"), localDate: date, kind: z.enum(["CLOSED_DAY", "REPLACE_DAY", "BLOCKS_ONLY"]), reason: z.string().trim().max(1000).nullable().optional(), intervals: z.array(exceptionInterval).max(42) }).strict(),
  z.object({ ...scheduleBase, op: z.literal("removeException"), localDate: date }).strict(),
]).superRefine((value, ctx) => {
  if (value.op === "removeException") return;
  if (value.op === "exception" && ((value.kind === "CLOSED_DAY" && value.intervals.length > 0)
    || (value.kind === "BLOCKS_ONLY" && value.intervals.some(row => row.kind !== "BLOCKED"))
    || (value.kind === "REPLACE_DAY" && !value.intervals.some(row => row.kind === "WORKING")))) {
    ctx.addIssue({ code: "custom", message: "Проверьте интервалы исключения", path: ["intervals"] });
  }
  const groups = new Map<string, { startMinute: number; endMinute: number }[]>();
  for (const row of value.intervals) {
    if (row.startMinute >= row.endMinute) ctx.addIssue({ code: "custom", message: "Начало интервала должно быть раньше конца", path: ["intervals"] });
    const key = "dayOfWeek" in row ? String(row.dayOfWeek) : row.kind;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const rows of groups.values()) {
    const sorted = [...rows].sort((a, b) => a.startMinute - b.startMinute);
    if (sorted.some((row, index) => index > 0 && row.startMinute < sorted[index - 1].endMinute)) ctx.addIssue({ code: "custom", message: "Интервалы одного дня или вида не должны пересекаться", path: ["intervals"] });
  }
});

export type AdminCatalogMutation = z.output<typeof adminCatalogMutationSchema>;
export type AdminScheduleMutation = z.output<typeof adminScheduleMutationSchema>;
