import { addCalendarDays, validCalendarDate } from "./salon-time";

export function adminCalendarRange(date: string, view: string): { from: string; to: string } | null {
  if (!validCalendarDate(date) || !["day", "week", "month"].includes(view)) return null;
  const from = view === "month" ? date.slice(0, 7) + "-01" : date;
  const monthEnd = new Date(`${from}T12:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const to = view === "day" ? date : view === "week" ? addCalendarDays(date, 6) : monthEnd.toISOString().slice(0, 10);
  return validCalendarDate(to) ? { from, to } : null;
}
