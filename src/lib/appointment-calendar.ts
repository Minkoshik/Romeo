import type { AppointmentView } from "./appointment-types";
import { calendarTimestamp, escapeCalendarText, foldCalendarLine } from "./calendar-format";

export function buildAppointmentCalendar(view: AppointmentView, now = new Date()): string {
  if (view.status !== "CONFIRMED") throw new Error("Добавить в календарь можно только подтверждённую запись");
  const details = view.details;
  const test = view.payments.some(payment => payment.mode === "TEST" && payment.status === "SUCCEEDED");
  const description = [
    `Запись РОМЕО-${view.number}. Мастер: ${details.masterName}.`,
    `Услуги: ${details.items.map(item => item.serviceName).join(", ")}.`,
    `Телефон салона: ${details.salonPhone}.`,
    ...(test ? ["Подтверждено тестовым адаптером. Деньги не списывались."] : []),
  ].join("\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Romeo//Appointments//RU", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${escapeCalendarText(view.id)}@romeo.local`, `DTSTAMP:${calendarTimestamp(now)}`,
    `DTSTART:${calendarTimestamp(details.startsAt)}`, `DTEND:${calendarTimestamp(details.endsAt)}`,
    `SUMMARY:${escapeCalendarText(`${test ? "ТЕСТ: " : ""}${details.salonName} — визит`)}`,
    `LOCATION:${escapeCalendarText(details.salonAddress)}`, `DESCRIPTION:${escapeCalendarText(description)}`, "STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR"];
  return lines.flatMap(foldCalendarLine).join("\r\n") + "\r\n";
}
