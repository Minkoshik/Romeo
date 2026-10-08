import "dotenv/config";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { demoCategories, demoMasters, demoServices } from "../src/lib/demo-catalog";
import { getSalon } from "../src/lib/salon";
import type { Salon } from "../src/lib/types";

// A fixed UUID namespace identifies rows owned by this seed across repeated runs.
const demoNamespace = Buffer.from("57da8206f113494c89e49c93709f9299", "hex");

export class SeedConfigurationError extends Error {}

export function demoId(entity: string, slug: string): string {
  const bytes = createHash("sha1").update(demoNamespace).update(`${entity}:${slug}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function seedDemoCatalog(prisma: PrismaClient, salon: Salon = getSalon()) {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new SeedConfigurationError("Демонстрационное заполнение запрещено в production.");
  }
  if (salon.currency !== "RUB") {
    throw new SeedConfigurationError("Демонстрационные цены заданы в RUB. Для другой валюты подготовьте отдельный каталог.");
  }
  return prisma.$transaction(async (tx) => {
    const currentSettings = await tx.salonSettings.findUnique({ where: { id: "salon" } });
    if (currentSettings && !currentSettings.isDemo) {
      throw new SeedConfigurationError("База содержит настройки настоящего салона. Демонстрационный seed их не заменяет.");
    }
    const [realCategory, realService, realMaster] = await Promise.all([
      tx.serviceCategory.findFirst({ where: { isDemo: false }, select: { id: true } }),
      tx.service.findFirst({ where: { isDemo: false }, select: { id: true } }),
      tx.master.findFirst({ where: { isDemo: false }, select: { id: true } }),
    ]);
    if (realCategory || realService || realMaster) {
      throw new SeedConfigurationError("База содержит настоящий каталог. Демонстрационный seed не будет его изменять.");
    }
    const activeVariantIds = new Set(demoServices.flatMap(service => service.variants.map(variant => demoId("variant", variant.id))));
    const activeAssignmentIds = new Set(demoMasters.flatMap(master => demoServices
      .filter(service => master.serviceIds.includes(service.id))
      .flatMap(service => service.variants.map(variant => demoId("master-service", `${master.id}:${variant.id}`)))));
    const serviceIds = demoServices.map(service => demoId("service", service.id));
    const masterIds = demoMasters.map(master => demoId("master", master.id));
    // Only deterministic seed ids are retired. Manually added rows are preserved.
    const oldVariants = await tx.serviceVariant.findMany({ where: { serviceId: { in: serviceIds } } });
    const ownedVariants = oldVariants.filter(variant => variant.id === demoId("variant", variant.slug));
    const oldAssignments = await tx.masterService.findMany({
      where: { masterId: { in: masterIds } },
      include: { master: { select: { slug: true } }, serviceVariant: { select: { id: true, slug: true } } },
    });
    const ownedAssignments = oldAssignments.filter(assignment => assignment.id === demoId("master-service", `${assignment.master.slug}:${assignment.serviceVariant.slug}`));
    // Never take a deterministic id away from a row reassigned elsewhere.
    const expectedVariants = new Map(demoServices.flatMap(service => service.variants.map(variant => [demoId("variant", variant.id), demoId("service", service.id)] as const)));
    const existingExpectedVariants = await tx.serviceVariant.findMany({ where: { id: { in: [...activeVariantIds] } }, select: { id: true, serviceId: true } });
    if (existingExpectedVariants.some(variant => expectedVariants.get(variant.id) !== variant.serviceId)) {
      throw new SeedConfigurationError("Идентификатор демонстрационного варианта уже используется другой услугой. Seed не будет его заменять.");
    }
    const retireAt = new Date();
    let archivedVariants = 0;
    let archivedAssignments = 0;
    for (const assignment of ownedAssignments) {
      if (!activeAssignmentIds.has(assignment.id) && (assignment.isActive || !assignment.archivedAt)) {
        await tx.masterService.update({ where: { id: assignment.id }, data: { isActive: false, archivedAt: assignment.archivedAt ?? retireAt } });
        archivedAssignments++;
      }
    }
    for (const variant of ownedVariants) {
      if (!activeVariantIds.has(variant.id) && (variant.isActive || !variant.archivedAt)) {
        await tx.serviceVariant.update({ where: { id: variant.id }, data: { isActive: false, archivedAt: variant.archivedAt ?? retireAt } });
        archivedVariants++;
      }
    }
    const policy = salon.policy;
    const settings = {
      name: salon.name, address: salon.address, phone: salon.phone,
      currency: salon.currency, timezone: salon.timezone, phoneCountry: salon.country,
      bookingHorizonDays: policy.bookingHorizonDays, minimumLeadMinutes: policy.minimumLeadMinutes,
      slotStepMinutes: policy.slotStepMinutes, holdDurationMinutes: policy.holdDurationMinutes,
      bufferMinutes: policy.bufferMinutes, prepaymentMode: policy.prepaymentMode,
      prepaymentFixedMinor: policy.prepaymentMode === "FIXED" ? policy.prepaymentFixedMinor : null,
      prepaymentPercentageBps: policy.prepaymentMode === "PERCENTAGE" ? Math.round(policy.prepaymentPercentage * 100) : null,
      bookingTerms: policy.bookingTerms, privacyTerms: policy.privacyTerms, isDemo: true,
    };
    await tx.salonSettings.upsert({ where: { id: "salon" }, create: { id: "salon", ...settings }, update: settings });
    for (const [sortOrder, category] of demoCategories.entries()) {
      const id = demoId("category", category.id);
      const data = { slug: category.id, name: category.name, description: category.description, sortOrder, isActive: true, isDemo: true, archivedAt: null };
      await tx.serviceCategory.upsert({ where: { id }, create: { id, ...data }, update: data });
    }
    for (const [sortOrder, service] of demoServices.entries()) {
      const id = demoId("service", service.id);
      const data = {
        categoryId: demoId("category", service.categoryId), slug: service.id,
        name: service.name, shortDescription: service.description, detailedDescription: service.details,
        sortOrder, isFeatured: service.popular ?? false, isActive: true, isDemo: true, archivedAt: null,
      };
      await tx.service.upsert({ where: { id }, create: { id, ...data }, update: data });
      for (const [variantOrder, variant] of service.variants.entries()) {
        const variantId = demoId("variant", variant.id);
        const variantData = {
          serviceId: id, slug: variant.id, name: variant.name,
          priceMinor: variant.priceMinor, durationMinutes: variant.durationMinutes,
          bufferMinutes: 0, sortOrder: variantOrder, isActive: true, archivedAt: null,
        };
        await tx.serviceVariant.upsert({ where: { id: variantId }, create: { id: variantId, ...variantData }, update: variantData });
      }
    }
    for (const [sortOrder, master] of demoMasters.entries()) {
      const id = demoId("master", master.id);
      const data = { slug: master.id, name: master.name, specialization: master.specialty, description: master.description, sortOrder, isBookable: true, isDemo: true, archivedAt: null };
      await tx.master.upsert({ where: { id }, create: { id, ...data }, update: data });
      for (const service of demoServices.filter(service => master.serviceIds.includes(service.id))) {
        for (const variant of service.variants) {
          const assignmentId = demoId("master-service", `${master.id}:${variant.id}`);
          const override = master.overrides?.[variant.id];
          const assignment = {
            masterId: id, serviceVariantId: demoId("variant", variant.id),
            priceMinorOverride: override?.priceMinor ?? null,
            durationMinutesOverride: override?.durationMinutes ?? null,
            bufferMinutesOverride: null, isActive: true, archivedAt: null,
          };
          const currentAssignment = await tx.masterService.findUnique({ where: { id: assignmentId }, select: { masterId: true, serviceVariantId: true } });
          if (currentAssignment && (currentAssignment.masterId !== assignment.masterId || currentAssignment.serviceVariantId !== assignment.serviceVariantId)) {
            throw new SeedConfigurationError("Идентификатор демонстрационного назначения используется другой парой мастера и услуги. Seed не будет его заменять.");
          }
          await tx.masterService.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...assignment }, update: assignment });
        }
      }
      // Demo: Monday-Saturday, 10:00-14:00 and 15:00-20:00 in salon time.
      for (let dayOfWeek = 1; dayOfWeek <= 6; dayOfWeek++) {
        for (const [startMinute, endMinute] of [[600, 840], [900, 1200]]) {
          const scheduleId = demoId("weekly-schedule", `${master.id}:${dayOfWeek}:${startMinute}`);
          const schedule = { masterId: id, dayOfWeek, startMinute, endMinute };
          await tx.weeklySchedule.upsert({ where: { id: scheduleId }, create: { id: scheduleId, ...schedule }, update: schedule });
        }
      }
    }
    return { categories: demoCategories.length, services: demoServices.length, variants: activeVariantIds.size, masters: demoMasters.length, assignments: activeAssignmentIds.size, archivedVariants, archivedAssignments };
  }, { maxWait: 5_000, timeout: 30_000 });
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SeedConfigurationError("Для заполнения базы задайте DATABASE_URL.");
  const schema = new URL(connectionString).searchParams.get("schema") ?? "public";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) throw new SeedConfigurationError("Некорректная схема базы данных.");
  const adapter = new PrismaPg({ connectionString, options: "-c timezone=UTC -c search_path=" + schema + ",public", max: 3, connectionTimeoutMillis: 5_000 }, { schema });
  const prisma = new PrismaClient({ adapter });
  try {
    const result = await seedDemoCatalog(prisma);
    console.info(`Демонстрационная база заполнена: ${result.categories} категорий, ${result.services} услуг, ${result.variants} вариантов, ${result.masters} мастера. Архивировано ${result.archivedVariants} вариантов и ${result.archivedAssignments} назначений. Администратор и настоящие записи не создавались.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Importing the seed runner for integration checks never connects or writes by itself.
if (process.argv[1] && resolve(process.argv[1]) === resolve("prisma/seed.ts")) {
  main().catch((error: unknown) => {
    // Do not print driver errors: a connection error can contain credentials.
    const message = error instanceof SeedConfigurationError
      ? error.message
      : "Демонстрационное заполнение не выполнено. Проверьте DATABASE_URL, доступность PostgreSQL и применение миграций.";
    console.error(message);
    process.exitCode = 1;
  });
}
