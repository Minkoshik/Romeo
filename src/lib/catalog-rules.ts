import type { Catalog, Master, QuoteItem } from "./types";

export class CatalogSelectionError extends Error {
  constructor(message: string, public readonly fieldErrors?: Record<string, string>) { super(message); }
}

export function masterCanPerform(master: Master, items: { serviceId: string; variantId: string }[]): boolean {
  return items.length > 0 && items.every(item => master.variantIds !== undefined
    ? master.variantIds.includes(item.variantId)
    : master.serviceIds.includes(item.serviceId));
}

export function resolveCatalogSelection(catalog: Catalog, variantIds: string[], masterId: string): { master: Master; items: QuoteItem[]; totalPriceMinor: number; totalDurationMinutes: number; totalBufferMinutes: number } {
  if (!variantIds.length || variantIds.length > 20) throw new CatalogSelectionError("Выберите от одной до двадцати услуг", { variantIds: "Проверьте набор услуг" });
  const master = catalog.masters.find(item => item.id === masterId);
  if (!master) throw new CatalogSelectionError("Мастер больше недоступен. Выберите другого мастера", { masterId: "Выберите доступного мастера" });
  const seenServices = new Set<string>();
  const items: QuoteItem[] = variantIds.map(variantId => {
    const service = catalog.services.find(item => item.variants.some(variant => variant.id === variantId));
    const variant = service?.variants.find(item => item.id === variantId);
    if (!service || !variant) throw new CatalogSelectionError("Услуга больше недоступна. Обновите каталог", { variantIds: "Выберите действующие услуги" });
    if (seenServices.has(service.id)) throw new CatalogSelectionError("Для каждой услуги можно выбрать только один вариант", { variantIds: "Уберите повторяющиеся услуги" });
    seenServices.add(service.id);
    const override = master.overrides?.[variant.id];
    return { serviceId: service.id, variantId: variant.id, serviceName: service.name, variantName: variant.name,
      priceMinor: override?.priceMinor ?? variant.priceMinor, durationMinutes: override?.durationMinutes ?? variant.durationMinutes,
      bufferMinutes: override?.bufferMinutes ?? variant.bufferMinutes ?? 0 };
  });
  if (!masterCanPerform(master, items)) throw new CatalogSelectionError("Выбранный мастер выполняет не все варианты услуг. Измените выбор", { masterId: "Выберите мастера для всех выбранных вариантов" });
  return { master, items, totalPriceMinor: items.reduce((sum, item) => sum + item.priceMinor, 0), totalDurationMinutes: items.reduce((sum, item) => sum + item.durationMinutes, 0),
    totalBufferMinutes: (catalog.salon?.policy.bufferMinutes ?? 0) + items.reduce((sum, item) => sum + (item.bufferMinutes ?? 0), 0) };
}
