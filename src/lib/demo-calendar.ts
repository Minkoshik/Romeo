import type { DemoQuote } from "./types";
import { calendarTimestamp, escapeCalendarText, foldCalendarLine } from "./calendar-format";

export function buildDemoCalendar(quote: DemoQuote, id: string, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Romeo//Demo booking//RU",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeCalendarText(id)}@romeo.demo`,
    `DTSTAMP:${calendarTimestamp(now)}`,
    `DTSTART:${calendarTimestamp(quote.startsAt)}`,
    `DTEND:${calendarTimestamp(quote.endsAt)}`,
    `SUMMARY:${escapeCalendarText(`ДЕМО: ${quote.salon.name} — визит`)}`,
    `LOCATION:${escapeCalendarText(quote.salon.address)}`,
    `DESCRIPTION:${escapeCalendarText(`Демонстрация: настоящая запись не создана. Мастер: ${quote.master.name}. Услуги: ${quote.items.map(item => item.serviceName).join(", ")}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.flatMap(foldCalendarLine).join("\r\n") + "\r\n";
}
