import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getDatabase } from "./db";
import { salonSchema } from "./salon";
import type { Catalog, Master } from "./types";

export class CatalogUnavailableError extends Error {
  constructor(message = "Каталог временно недоступен. Попробуйте ещё раз через несколько секунд.") { super(message); }
}

// Reused by the availability repository so settings, catalog and schedule are
// read from the same consistent database snapshot.
export async function readDatabaseCatalog(tx: Prisma.TransactionClient): Promise<Catalog> {
      const settings = await tx.salonSettings.findUnique({ where: { id: "salon" } });
      if (!settings) throw new CatalogUnavailableError("Каталог ещё не настроен. Попробуйте позже.");
      const salon = { ...salonSchema.parse({ name: settings.name, address: settings.address, phone: settings.phone,
        currency: settings.currency, timezone: settings.timezone, country: settings.phoneCountry,
        policy: { bookingHorizonDays: settings.bookingHorizonDays, minimumLeadMinutes: settings.minimumLeadMinutes,
          slotStepMinutes: settings.slotStepMinutes, holdDurationMinutes: settings.holdDurationMinutes, bufferMinutes: settings.bufferMinutes,
          prepaymentMode: settings.prepaymentMode, prepaymentFixedMinor: settings.prepaymentFixedMinor ?? 0, cancellationLeadMinutes: settings.cancellationLeadMinutes, rescheduleLeadMinutes: settings.rescheduleLeadMinutes,
          prepaymentPercentage: (settings.prepaymentPercentageBps ?? 0) / 100, bookingTerms: settings.bookingTerms, privacyTerms: settings.privacyTerms } }), email: settings.email ?? "", logoUrl: settings.logoUrl ?? "" };
      const rows = await tx.serviceCategory.findMany({ where: { isActive: true, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        include: { services: { where: { isActive: true, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          include: { variants: { where: { isActive: true, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } } } } });
      const services = rows.flatMap(category => category.services.filter(service => service.variants.length > 0).map(service => ({
        id: service.id, slug: service.slug, categoryId: category.id, name: service.name, description: service.shortDescription,
        details: service.detailedDescription ?? "", imageUrl: service.imageUrl ?? "", popular: service.isFeatured, isDemo: service.isDemo,
        variants: service.variants.map(variant => ({ id: variant.id, name: variant.name, priceMinor: variant.priceMinor, durationMinutes: variant.durationMinutes, bufferMinutes: variant.bufferMinutes })) })));
      const categories = rows.filter(row => services.some(service => service.categoryId === row.id)).map(row => ({
        id: row.id, slug: row.slug, name: row.name, description: row.description ?? "", isDemo: row.isDemo }));
      const activeVariants = new Map(services.flatMap(service => service.variants.map(variant => [variant.id, service.id] as const)));
      const masterRows = await tx.master.findMany({ where: { isBookable: true, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        include: { services: { where: { isActive: true, archivedAt: null } } } });
      const masters: Master[] = masterRows.flatMap((row, index) => {
        const assignments = row.services.filter(assignment => activeVariants.has(assignment.serviceVariantId));
        if (!assignments.length) return [];
        return [{ id: row.id, slug: row.slug, name: row.name, specialty: row.specialization, description: row.description, photoUrl: row.photoUrl ?? "", isDemo: row.isDemo,
          initials: row.name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join(""), color: ["sage", "rose", "sand"][index % 3],
          serviceIds: [...new Set(assignments.map(assignment => activeVariants.get(assignment.serviceVariantId)!))], variantIds: assignments.map(assignment => assignment.serviceVariantId),
          overrides: Object.fromEntries(assignments.filter(assignment => assignment.priceMinorOverride !== null || assignment.durationMinutesOverride !== null || assignment.bufferMinutesOverride !== null).map(assignment => [assignment.serviceVariantId, {
            ...(assignment.priceMinorOverride === null ? {} : { priceMinor: assignment.priceMinorOverride }),
            ...(assignment.durationMinutesOverride === null ? {} : { durationMinutes: assignment.durationMinutesOverride }),
            ...(assignment.bufferMinutesOverride === null ? {} : { bufferMinutes: assignment.bufferMinutesOverride }) }])) }];
      });
      return { source: "database", isDemo: settings.isDemo && services.every(service => service.isDemo) && masters.every(master => master.isDemo), salon, categories, services, masters };
}

export async function loadDatabaseCatalog(databaseOverride?: PrismaClient): Promise<Catalog> {
  try {
    const database = databaseOverride ?? getDatabase();
    return await database.$transaction(readDatabaseCatalog, { isolationLevel: "RepeatableRead", timeout: 10000, maxWait: 5000 });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) throw error;
    // Driver messages can contain credentials. Return only a public Russian message.
    throw new CatalogUnavailableError();
  }
}
