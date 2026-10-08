export function money(minor: number, currency: string) {
  const digits = new Intl.NumberFormat("ru-RU", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** digits;
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency, maximumFractionDigits: digits, minimumFractionDigits: minor % scale === 0 ? 0 : digits }).format(minor / scale);
}
export function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} ч` : "", rest ? `${rest} мин` : ""].filter(Boolean).join(" ") || "0 мин";
}
export function servicesCount(count: number) {
  const last = count % 10, lastTwo = count % 100;
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? "услуг" : last === 1 ? "услуга" : last >= 2 && last <= 4 ? "услуги" : "услуг"}`;
}
