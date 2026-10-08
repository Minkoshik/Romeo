"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, Clock3, Download, Info, LockKeyhole, MapPin, RefreshCw } from "lucide-react";
import type { AppointmentView } from "@/lib/appointment-types";
import { buildAppointmentCalendar } from "@/lib/appointment-calendar";
import { formatSalonDate, salonTimeParts } from "@/lib/salon-time";
import { duration, money } from "@/lib/format";
import { useBooking } from "./booking-provider";
import { StepHeader } from "./site-shell";
import { PaymentPanel } from "./payment-panel";

export function appointmentLink(id: string, accessToken: string) {
  return `/appointment/${encodeURIComponent(id)}#token=${encodeURIComponent(accessToken)}`;
}

export function AppointmentSummary({ view }: { view: AppointmentView }) {
  const d = view.details;
  const testPayment = view.payments.some(payment => payment.mode === "TEST" && payment.status === "SUCCEEDED");
  const start = salonTimeParts(new Date(d.startsAt), d.timezone);
  const end = salonTimeParts(new Date(d.endsAt), d.timezone);
  return <section className="content-card review-card">
    <div className="review-block"><h3>{d.salonName}</h3><p className="review-address"><MapPin size={14}/>{d.salonAddress}</p></div>
    <div className="review-block review-services">{d.items.map((item, index) => <div key={index}><span><b>{item.serviceName}</b>{!["Основной", "Стандартная", "Стандартный", "Стандартное", "Комплекс"].includes(item.variantName) && <small>{item.variantName}</small>}<small>{duration(item.durationMinutes)}</small></span><strong>{money(item.priceMinor, d.currency)}</strong></div>)}</div>
    <div className="review-block"><div className="review-line"><span>Мастер</span><b>{d.masterName}</b></div><div className="review-line"><CalendarDays size={14}/><b>{formatSalonDate(start.date)}</b></div><div className="review-line"><Clock3 size={14}/><b>{start.time}–{end.time}{start.date !== end.date && ` · ${formatSalonDate(end.date)}`}</b></div><small className="timezone-caption">{duration(d.totalDurationMinutes)} · {d.timezone}</small></div>
    <div className="review-block"><h3>Контакты</h3><p className="review-contact">{d.contacts.name}<br/>{d.contacts.phone}{d.contacts.email && <><br/>{d.contacts.email}</>}</p>{d.contacts.comment && <p className="review-comment">{d.contacts.comment}</p>}</div>
    <div className="review-total"><div><span>Стоимость визита</span><strong>{money(d.totalPriceMinor, d.currency)}</strong></div><div><span>Требуемая предоплата</span><b>{money(d.prepaymentRequiredMinor, d.currency)}</b></div><div><span>{testPayment ? "Тестово оплачено" : "Внесено"}</span><b>{money(view.paidMinor, d.currency)}</b></div><div><span>{testPayment ? "Остаток по тестовому расчёту" : "Остаток к оплате"}</span><b>{money(view.remainingMinor, d.currency)}</b></div>{testPayment && <small>Деньги не списывались. Суммы показывают результат тестового сценария.</small>}</div>
    <div className="review-block"><p>Телефон салона: {d.salonPhone}</p><details><summary>Сохранённые условия записи</summary><p style={{whiteSpace:"pre-wrap"}}>{d.bookingTerms}</p><p style={{whiteSpace:"pre-wrap"}}>{d.privacyTerms}</p></details></div>
  </section>;
}

export function AppointmentScreen({ id, accessToken: suppliedToken }: { id: string; accessToken?: string }) {
  const { clear } = useBooking();
  const router = useRouter();
  const [fragmentToken, setFragmentToken] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; view: AppointmentView | null; error: string | null }>({ key:"", view:null, error:null });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [calendarError, setCalendarError] = useState(false);
  const clock = useRef<{ key: string; server: number; monotonic: number } | null>(null);
  useEffect(() => {
    const read = () => setFragmentToken(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
    const initial = window.setTimeout(read, 0);
    window.addEventListener("hashchange", read);
    return () => { window.clearTimeout(initial); window.removeEventListener("hashchange", read); };
  }, []);
  const token = suppliedToken ?? fragmentToken;
  const key = `${id}|${token ?? ""}`;
  const valid = /^[0-9a-f-]{36}$/i.test(id) && typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  useEffect(() => {
    if (!valid || !token) return;
    let mounted = true;
    let controller: AbortController | null = null;
    async function load() {
      controller?.abort();
      const current = new AbortController(); controller = current;
      try {
        const response = await fetch(`/api/appointments/${encodeURIComponent(id)}`, { headers:{Authorization:`Bearer ${token}`}, cache:"no-store", signal:current.signal });
        const data = await response.json();
        if (!mounted || current.signal.aborted) return;
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить запись. Повторите попытку.");
        if (data.source !== "database" || data.id !== id || !data.details || !Number.isFinite(Date.parse(data.serverNow))) throw new Error("Не удалось проверить статус записи.");
        const monotonic = performance.now();
        const previous = clock.current;
        const server = previous?.key === key ? Math.max(Date.parse(data.serverNow),previous.server + monotonic - previous.monotonic) : Date.parse(data.serverNow);
        clock.current = { key, server, monotonic };
        setNow(clock.current.server);
        setResult({key,view:data as AppointmentView,error:null});
      } catch (cause) {
        if (!mounted || current.signal.aborted) return;
        const error = cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError) ? cause.message : "Не удалось обновить запись. Проверьте соединение и повторите попытку.";
        setResult(previous => ({key,view:previous.key === key ? previous.view : null,error}));
      }
    }
    const initial = window.setTimeout(load,0);
    const poll = window.setInterval(load,15_000);
    const tick = window.setInterval(() => { if (clock.current) setNow(clock.current.server + performance.now() - clock.current.monotonic); },1_000);
    return () => { mounted=false; controller?.abort(); window.clearTimeout(initial); window.clearInterval(poll); window.clearInterval(tick); };
  }, [id,token,key,valid,attempt]);
  const current = result.key === key ? result : null;
  const view = current?.view;
  const seconds = view?.holdExpiresAt && now !== null ? Math.max(0,Math.ceil((Date.parse(view.holdExpiresAt)-now)/1000)) : null;
  async function copyLink() {
    if (!token) return;
    try { await navigator.clipboard.writeText(new URL(appointmentLink(id,token),window.location.origin).href); setCopied(true); }
    catch { setCopied(false); }
  }
  function downloadCalendar() {
    if (!view) return;
    try {
      const url = URL.createObjectURL(new Blob([buildAppointmentCalendar(view)], { type: "text/calendar;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `romeo-${view.number}.ics`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setCalendarError(false);
    } catch { setCalendarError(true); }
  }
  if (token === null) return <div className="content-card" role="status">Открываем личную запись…</div>;
  if (!valid) return <div className="empty-state"><LockKeyhole size={28}/><h2>Нужна личная ссылка</h2><p>Откройте полную ссылку, полученную после записи. Одного номера недостаточно для просмотра.</p><Link className="primary-button" href="/">К услугам</Link></div>;
  return <>
    <StepHeader title={view?.status === "CONFIRMED" ? "До встречи" : "Ваша запись"} caption="Запись сохранена. Здесь можно проверить её актуальный статус." step={view?.status === "CONFIRMED" ? 8 : 7}/>
    {current?.error && <div className="empty-state" role="alert"><Info size={25}/><h3>Не удалось обновить запись</h3><p>{current.error}</p><button className="secondary-button" onClick={() => setAttempt(value=>value+1)}><RefreshCw size={16}/>Попробовать снова</button></div>}
    {!view && !current?.error ? <div className="content-card" role="status">Проверяем запись на сервере…</div> : view && <>
      <div className="confirmation-banner">
        {view.status === "CONFIRMED" ? <CheckCircle2 size={35}/> : <Clock3 size={35}/>}
        <h3>{view.status === "CONFIRMED" ? "Запись подтверждена" : view.status === "WAITING_PAYMENT" ? "Время временно забронировано" : view.status === "EXPIRED" ? "Срок брони истёк" : view.status === "CANCELLED" ? "Запись отменена" : view.status === "COMPLETED" ? "Визит завершён" : "Отмечена неявка"}</h3>
        <span>РОМЕО-{view.number}</span>
        {view.status === "WAITING_PAYMENT" && <><p>До окончания брони: <b>{seconds === null ? "…" : `${Math.floor(seconds/60).toString().padStart(2,"0")}:${(seconds%60).toString().padStart(2,"0")}`}</b></p><p>{seconds === 0 ? "Проверяем окончание брони на сервере…" : "Этот интервал недоступен другим клиентам. Без оплаты бронь автоматически истечёт."}</p></>}
        {view.status === "EXPIRED" && <p>Время освобождено. Для нового визита выберите доступный интервал заново.</p>}
        {view.status === "CONFIRMED" && <p>{view.details.prepaymentRequiredMinor === 0 ? "Предоплата не требуется. Визит сохранён в расписании мастера." : view.payments.some(payment => payment.mode === "TEST" && payment.status === "SUCCEEDED") ? "Подтверждено проверенным тестовым платежом. Деньги не списывались. Визит сохранён в расписании мастера." : "Предоплата подтверждена. Визит сохранён в расписании мастера."}</p>}
      </div>
      <PaymentPanel key={key} view={view} accessToken={token!} seconds={seconds} refresh={() => setAttempt(value => value + 1)}/>
      <AppointmentSummary view={view}/>
      {view.status === "CONFIRMED" && <div className="content-card"><h3>Визит в календаре</h3><p>Сохраните дату, время, услуги и адрес салона в файл для вашего календаря.</p><button className="secondary-button" onClick={downloadCalendar}><Download size={15}/>Добавить в календарь</button>{calendarError && <p role="alert">Не удалось скачать файл. Обновите запись и повторите попытку.</p>}</div>}
      <div className="content-card"><h3>Личная ссылка</h3><p>Сохраните эту страницу в закладки или скопируйте ссылку. По ней запись откроется после перезагрузки; она даёт доступ к вашим контактам.</p><button className="secondary-button" onClick={copyLink}><LockKeyhole size={15}/>{copied ? "Ссылка скопирована" : "Скопировать личную ссылку"}</button><p className="schedule-caption">Email и SMS не отправлялись: сервис уведомлений не подключён.</p></div>
      <button className="primary-button full-width" onClick={()=>{clear();router.push("/");}}>Выбрать новый визит</button>
      {view.status === "WAITING_PAYMENT" && <p className="schedule-caption">Новый выбор не отменяет текущую бронь. Она действует до окончания своего срока.</p>}
    </>}
  </>;
}

export function ResumeAppointment() {
  const { appointment } = useBooking();
  return appointment ? <AppointmentScreen id={appointment.view.id} accessToken={appointment.accessToken}/> : <div className="empty-state"><h2>Откройте свою запись</h2><p>Используйте сохранённую личную ссылку или создайте новую запись после проверки выбора.</p><Link className="primary-button" href="/">К услугам</Link></div>;
}
