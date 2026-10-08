"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, RefreshCw, Sparkles } from "lucide-react";
import { useBooking } from "./booking-provider";
import { useAvailability } from "./use-availability";
import { DemoNotice, FlowActions } from "./booking-flow-common";
import { StepHeader } from "./site-shell";
import { duration } from "@/lib/format";
import { addCalendarDays, formatSalonDate } from "@/lib/salon-time";

function monthOffset(month: string, offset: number) {
  const value = new Date(`${month}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + offset);
  return value.toISOString().slice(0, 7);
}
function shortDateReason(reason: string) {
  if (reason.includes("Прошедшая")) return "Прошло";
  if (reason.includes("пределами")) return "Позже";
  if (reason.includes("работает") || reason.includes("Выходной") || reason.includes("Нерабочий")) return "Не работает";
  return "Нет мест";
}
function ScheduleState({ loading, error, catalogChanged, refresh }: { loading: boolean; error: string | null; catalogChanged: boolean; refresh: () => void }) {
  const { reload } = useBooking();
  return error ? <div className="empty-state" role="alert"><CalendarDays size={26}/><h3>Не удалось загрузить расписание</h3><p>{error}</p><button className="secondary-button" onClick={catalogChanged ? reload : refresh}><RefreshCw size={16}/>{catalogChanged ? "Обновить каталог" : "Попробовать снова"}</button></div>
    : loading ? <div className="content-card" role="status">Загружаем расписание…</div> : null;
}

export function DateSelection() {
  const { master, totalMinutes, date, setDate, setTime } = useBooking();
  const router = useRouter();
  const schedule = useAvailability();
  const { data, loading, error } = schedule;
  const [month, setMonth] = useState<string | null>(null);
  if (!master) return null;
  const firstMonth = data?.today.slice(0, 7);
  const lastMonth = data?.lastDate.slice(0, 7);
  const requestedMonth = month ?? (date ?? data?.today)?.slice(0, 7);
  const visibleMonth = requestedMonth && firstMonth && lastMonth ? requestedMonth < firstMonth ? firstMonth : requestedMonth > lastMonth ? lastMonth : requestedMonth : null;
  const days = (() => {
    if (!data || !visibleMonth) return [];
    const first = `${visibleMonth}-01`;
    const count = Number(addCalendarDays(`${monthOffset(visibleMonth, 1)}-01`, -1).slice(-2));
    const available = new Map(data.days.map(day => [day.date, day]));
    return Array.from({ length: count }, (_, index) => {
      const value = addCalendarDays(first, index);
      return available.get(value) ?? { date: value, status: "closed", availableCount: 0, reason: value < data.today ? "Прошедшая дата" : "Дата за пределами открытой записи" };
    });
  })();
  const selectedIsAvailable = !loading && !error && Boolean(data?.days.some(day => day.date === date && day.status === "available"));
  const nearest = data?.nearest;
  const padding = visibleMonth ? (new Date(`${visibleMonth}-01T12:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const title = visibleMonth ? new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${visibleMonth}-01T12:00:00Z`)) : "Календарь";
  return <>
    <StepHeader title="Выбор даты" caption="Найдите день, в который удобно прийти." step={3} back="/masters"/>
    <DemoNotice>Доступность рассчитана по расписанию мастера. Выбор даты пока не резервирует время.</DemoNotice>
    <div className="selection-summary"><CalendarDays size={18}/><span><b>{master.name}</b><small>{duration(data?.totalDurationMinutes ?? totalMinutes)} на выбранные услуги{data && ` · ${data.timezone}`}</small></span></div>
    {error || !data ? <ScheduleState {...schedule}/> : <section className="content-card calendar-card" aria-label="Календарь свободных дат" aria-busy={loading}>
      <div className="calendar-toolbar"><button className="calendar-nav" aria-label="Предыдущий месяц" disabled={loading || visibleMonth! <= firstMonth!} onClick={() => setMonth(monthOffset(visibleMonth!, -1))}><ChevronLeft size={18}/></button><h3 aria-live="polite">{title}</h3><button className="calendar-nav" aria-label="Следующий месяц" disabled={loading || visibleMonth! >= lastMonth!} onClick={() => setMonth(monthOffset(visibleMonth!, 1))}><ChevronRight size={18}/></button></div>
      <div className="calendar-weekdays" aria-hidden="true">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-grid">{Array.from({ length: padding }, (_, index) => <span key={`empty-${index}`} aria-hidden="true"/>)}{days.map(day => <button key={day.date} className={`calendar-day ${date === day.date ? "selected" : ""} ${data.today === day.date ? "today" : ""}`} disabled={loading || day.status !== "available"} aria-pressed={date === day.date} aria-label={`${formatSalonDate(day.date)}. ${day.reason}${data.today === day.date ? ". Сегодня" : ""}`} onClick={() => setDate(day.date)}><span>{Number(day.date.slice(-2))}</span><small className="calendar-day-status">{day.status === "available" ? "Свободно" : shortDateReason(day.reason)}</small></button>)}</div>
      <p className="calendar-legend">«Свободно» — есть время на весь визит и технический перерыв. {loading ? "Обновляем доступность…" : "Остальные даты недоступны."}</p>
    </section>}
    {date && data && !error && <div className="slot-selection" role="status"><Check size={17}/><span>{formatSalonDate(date)}{!loading && !selectedIsAvailable && <small>На эту дату уже нет подходящего времени. Выберите другую.</small>}</span></div>}
    {data && !error && <><button className="secondary-button full-width nearest-slot" disabled={loading || !nearest} onClick={() => { if (!nearest) return; setDate(nearest.date); setTime(nearest.slot.time); router.push("/time"); }}><Sparkles size={17}/><span>{nearest ? "Ближайшее свободное время" : "Нет подходящего времени в этом периоде"}{nearest && <small>{formatSalonDate(nearest.date)} · {nearest.slot.time}</small>}</span></button><p className="schedule-caption">Запись открыта на {data.days.length} дней. Все даты и время указаны по часовому поясу салона: {data.timezone}.</p></>}
    <FlowActions back="/masters" next="/time" disabled={!selectedIsAvailable}/>
  </>;
}

export function TimeSelection() {
  const { master, date, time, totalMinutes, setDate, setTime } = useBooking();
  const schedule = useAvailability(date ?? undefined);
  const { data, loading, error } = schedule;
  if (!master || !date) return null;
  const slots = data?.slots ?? [];
  const selectedSlot = !error && !loading ? slots.find(slot => slot.time === time && slot.status === "available") : null;
  const nearest = data?.nearest;
  const groups = [{ name: "Утро", from: "00:00", to: "12:00" }, { name: "День", from: "12:00", to: "17:00" }, { name: "Вечер", from: "17:00", to: "24:00" }];
  return <>
    <StepHeader title="Выбор времени" caption="Выберите начало визита. Все услуги выполняет один мастер." step={4} back="/date"/>
    <DemoNotice>Свободное время проверяется по расписанию. Бронь создаётся после проверки услуг и контактов.</DemoNotice>
    <div className="selection-summary"><Clock3 size={18}/><span><b>{formatSalonDate(date)}</b><small>{master.name} · {duration(data?.totalDurationMinutes ?? totalMinutes)}{data && ` · ${data.timezone}`}</small></span></div>
    {data && !error && <p className="availability-note">Весь визит{data.totalBufferMinutes ? ` и технический перерыв ${data.totalBufferMinutes} мин после него` : ""} должны помещаться в рабочий интервал мастера. {loading && "Обновляем доступность…"}</p>}
    {error || !data ? <ScheduleState {...schedule}/> : <>
      {!loading && !slots.some(slot => slot.status === "available") && <div className="inline-note" role="status"><CalendarDays size={18}/><span>На этот день подходящего времени нет. Выберите ближайший интервал или другую дату.</span></div>}
      <div className="time-groups" aria-busy={loading}>{groups.filter(group => slots.some(slot => slot.time >= group.from && slot.time < group.to)).map(group => <section className="content-card time-group" key={group.name} aria-label={group.name}><h3>{group.name}</h3><div className="time-grid">{slots.filter(slot => slot.time >= group.from && slot.time < group.to).map(slot => <button key={slot.time} className={`time-slot ${time === slot.time && slot.status === "available" ? "selected" : ""}`} disabled={loading || slot.status !== "available"} aria-pressed={time === slot.time && slot.status === "available"} aria-label={`${slot.time}. ${slot.reason}${slot.status === "available" ? `. Окончание ${slot.endTime}` : ""}`} onClick={() => setTime(slot.time)}><b>{slot.time}</b><small className="time-slot-status">{slot.reason}</small></button>)}</div></section>)}</div>
    </>}
    {selectedSlot && data ? <div className="slot-selection" role="status"><Check size={17}/><span>Визит {selectedSlot.time}–{selectedSlot.endTime}<small>{duration(data.totalDurationMinutes)} · {data.timezone}</small></span></div> : time && data && !error && !loading ? <div className="inline-note" role="status">Выбранное время стало недоступно. Выберите новый интервал.</div> : null}
    {data && !error && <button className="secondary-button full-width nearest-slot" disabled={loading || !nearest} onClick={() => { if (!nearest) return; setDate(nearest.date); setTime(nearest.slot.time); }}><Sparkles size={17}/><span>{nearest ? "Выбрать ближайшее свободное" : "Нет подходящих интервалов"}{nearest && <small>{formatSalonDate(nearest.date)} · {nearest.slot.time}</small>}</span></button>}
    <FlowActions back="/date" next="/contacts" disabled={!selectedSlot}/>
  </>;
}

