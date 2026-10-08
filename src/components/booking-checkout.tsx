"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, Info, LockKeyhole, MapPin, RefreshCw } from "lucide-react";
import { useBooking } from "./booking-provider";
import { DemoNotice, FlowActions, SelectionSummary } from "./booking-flow-common";
import { StepHeader } from "./site-shell";
import { createContactSchema, contactFieldErrors } from "@/lib/contact-validation";
import { formatSalonDate } from "@/lib/salon-time";
import { duration, money } from "@/lib/format";
import type { DemoQuote } from "@/lib/types";
import type { AppointmentView } from "@/lib/appointment-types";
import { appointmentLink } from "./appointment-view";

export function ContactsForm() {
  const { salon, contacts, consent, setContacts } = useBooking();
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createContactSchema(salon.country).safeParse(contacts);
    const nextErrors = parsed.success ? {} : contactFieldErrors(parsed.error);
    if (!consent) nextErrors.consent = "Ознакомьтесь с демонстрационными условиями и подтвердите согласие";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const field = event.currentTarget.elements.namedItem(Object.keys(nextErrors)[0]);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    if (parsed.success) { setContacts(parsed.data, consent); router.push("/review"); }
  }
  function change(field: keyof typeof contacts, value: string) {
    setContacts({ ...contacts, [field]: value }, consent);
    setErrors(current => ({ ...current, [field]: "" }));
  }
  return <><StepHeader title="Как с вами связаться" caption="Аккаунт не нужен. Только самое необходимое для визита." step={5} back="/time"/><DemoNotice>Салон демонстрационный: используйте вымышленные контакты. При создании записи они сохраняются в базе вместе с условиями визита.</DemoNotice><SelectionSummary/>
    <form className="content-card contacts-form" onSubmit={submit} noValidate>
      <div className="form-field"><label htmlFor="contact-name">Ваше имя <span>*</span></label><input id="contact-name" name="name" autoComplete="given-name" placeholder="Например, Алексей" maxLength={80} value={contacts.name} onChange={event => change("name", event.target.value)} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "error-name" : undefined}/>{errors.name && <small className="field-error" id="error-name">{errors.name}</small>}</div>
      <div className="form-field"><label htmlFor="contact-phone">Телефон <span>*</span></label><input id="contact-phone" name="phone" type="tel" autoComplete="tel" placeholder="+7 912 345-67-89" maxLength={40} value={contacts.phone} onChange={event => change("phone", event.target.value)} aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? "error-phone" : "phone-hint"}/><small id="phone-hint">Для другой страны укажите международный код с «+».</small>{errors.phone && <small className="field-error" id="error-phone">{errors.phone}</small>}</div>
      <div className="form-field"><label htmlFor="contact-email">Email <small>необязательно</small></label><input id="contact-email" name="email" type="email" autoComplete="email" placeholder="name@example.com" maxLength={254} value={contacts.email} onChange={event => change("email", event.target.value)} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "error-email" : undefined}/>{errors.email && <small className="field-error" id="error-email">{errors.email}</small>}</div>
      <div className="form-field"><label htmlFor="contact-comment">Пожелания мастеру <small>необязательно</small></label><textarea id="contact-comment" name="comment" rows={3} placeholder="Расскажите, что для вас важно" maxLength={1000} value={contacts.comment} onChange={event => change("comment", event.target.value)} aria-invalid={Boolean(errors.comment)}/>{errors.comment && <small className="field-error">{errors.comment}</small>}</div>
      <div className="consent-row"><input id="contact-consent" name="consent" type="checkbox" checked={consent} onChange={event => { setContacts(contacts, event.target.checked); setErrors(current => ({ ...current, consent: "" })); }} aria-invalid={Boolean(errors.consent)} aria-describedby={errors.consent ? "error-consent" : undefined}/><label htmlFor="contact-consent">Я ознакомился с <Link href="/terms">демонстрационными условиями записи</Link> и <Link href="/privacy">текстом об обработке данных</Link>.</label></div>{errors.consent && <small className="field-error" id="error-consent">{errors.consent}</small>}
      {Object.values(errors).some(Boolean) && <p className="form-error-summary" role="alert">Проверьте выделенные поля.</p>}
      <div className="flow-actions"><Link className="secondary-button" href="/time"><ArrowLeft size={15}/>Назад</Link><button type="submit" className="primary-button">Проверить запись<ArrowRight size={16}/></button></div>
    </form><p className="schedule-caption"><LockKeyhole size={12}/>Контакты не сохраняются в браузерных хранилищах.</p></>;
}

export function QuoteSummary({ quote, editable = false }: { quote: DemoQuote; editable?: boolean }) {
  return <><section className="content-card review-card"><div className="review-block"><div className="review-title"><h3>{quote.salon.name}</h3>{editable && <Link href="/">Изменить услуги</Link>}</div><p className="review-address"><MapPin size={14}/>{quote.salon.address}</p></div><div className="review-block review-services">{quote.items.map(item => <div key={item.variantId}><span><b>{item.serviceName}</b>{!["Стандартная", "Стандартный", "Стандартное", "Комплекс"].includes(item.variantName) && <small>{item.variantName}</small>}<small>{duration(item.durationMinutes)}</small></span><strong>{money(item.priceMinor, quote.currency)}</strong></div>)}</div><div className="review-block"><div className="review-line"><span>Мастер</span><b>{quote.master.name}</b>{editable && <Link href="/masters">Изменить</Link>}</div><div className="review-line"><CalendarDays size={14}/><b>{formatSalonDate(quote.date)}</b>{editable && <Link href="/date">Изменить</Link>}</div><div className="review-line"><Clock3 size={14}/><b>{quote.time}–{quote.endsAtLocal}</b>{editable && <Link href="/time">Изменить</Link>}</div><small className="timezone-caption">{duration(quote.totalDurationMinutes)} · часовой пояс {quote.salon.timezone}</small></div><div className="review-block"><div className="review-title"><h3>Контакты</h3>{editable && <Link href="/contacts">Изменить</Link>}</div><p className="review-contact">{quote.contacts.name}<br/>{quote.contacts.phone}{quote.contacts.email && <><br/>{quote.contacts.email}</>}</p>{quote.contacts.comment && <p className="review-comment">{quote.contacts.comment}</p>}</div><div className="review-total"><div><span>Стоимость визита</span><strong>{money(quote.totalPriceMinor, quote.currency)}</strong></div><div><span>Требуемая предоплата</span><b>{money(quote.prepaymentMinor, quote.currency)}</b></div><div><span>Остаток после предоплаты</span><b>{money(quote.remainingMinor, quote.currency)}</b></div></div></section></>;
}

export function ReviewBooking() {
  const { salon, selected, master, date, time, contacts, consent, quote, setQuote, revision, appointment, prepareAppointment, saveAppointment, pendingAppointmentIntent, clearAppointmentIntent, reload } = useBooking();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checkedBody, setCheckedBody] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const busy = useRef(false);
  const quoteSetter = useRef(setQuote);
  useEffect(() => { quoteSetter.current = setQuote; }, [setQuote]);
  const requestBody = JSON.stringify({ variantIds: selected.map(item => item.variant.id), masterId: master?.id, date, time, contacts, consent });
  useEffect(() => {
    if (appointment || pendingAppointmentIntent) return;
    const controller = new AbortController();
    fetch("/api/demo/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody, signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "Не удалось проверить запись. Попробуйте ещё раз.");
      if (data.source !== "demo") throw new Error("Получен некорректный результат проверки.");
      if (data.salon?.policy.bookingTerms !== salon.policy.bookingTerms || data.salon?.policy.privacyTerms !== salon.policy.privacyTerms) throw new Error("Условия записи изменились. Обновите каталог и ознакомьтесь с ними заново.");
      quoteSetter.current(data as DemoQuote, revision); setCheckedBody(requestBody); setError(null);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError) ? cause.message : "Не удалось проверить запись. Проверьте соединение и повторите попытку."); });
    return () => controller.abort();
  }, [requestBody, revision, attempt, appointment, pendingAppointmentIntent, salon.policy.bookingTerms, salon.policy.privacyTerms]);
  const checkedQuote = checkedBody === requestBody && !error ? quote : null;
  async function proceed() {
    if (busy.current || (!checkedQuote && !pendingAppointmentIntent)) return;
    busy.current = true; setCreating(true); setCreateError(null); setCanEdit(false);
    try {
      const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,"0")).join("");
      const conditions = checkedQuote && {totalPriceMinor:checkedQuote.totalPriceMinor,totalDurationMinutes:checkedQuote.totalDurationMinutes,totalBufferMinutes:checkedQuote.totalBufferMinutes??0,prepaymentRequiredMinor:checkedQuote.prepaymentMinor,currency:checkedQuote.currency,timezone:checkedQuote.salon.timezone,bookingTermsVersion:await digest(checkedQuote.salon.policy.bookingTerms),privacyTermsVersion:await digest(checkedQuote.salon.policy.privacyTerms)};
      const intent = pendingAppointmentIntent ?? prepareAppointment(JSON.stringify({...JSON.parse(requestBody),expectedConditions:conditions}));
      const response = await fetch("/api/appointments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...JSON.parse(intent.body),idempotencyKey:intent.idempotencyKey,accessToken:intent.accessToken})});
      const data = await response.json();
      if (!response.ok) { setCanEdit(response.status>=400 && response.status<500); throw new Error(data.error??"Не удалось создать запись. Повторите попытку."); }
      if (data.source!=="database" || !data.id || !data.details) throw new Error("Не удалось проверить результат. Повторите запрос.");
      saveAppointment(data as AppointmentView,intent.accessToken);
      router.push(appointmentLink(data.id,intent.accessToken));
    } catch(cause) {
      setCreateError(cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError) ? cause.message : "Ответ сервера не получен. Повторите запрос: одна и та же запись не будет создана дважды.");
    } finally {busy.current=false;setCreating(false);}
  }
  if (appointment) return <div className="content-card"><h2>Запись уже сохранена</h2><p>Откройте личную страницу, чтобы увидеть актуальный статус брони и условия визита.</p><Link className="primary-button" href={appointmentLink(appointment.view.id,appointment.accessToken)}>Открыть запись</Link></div>;
  if (pendingAppointmentIntent) {
    const original = JSON.parse(pendingAppointmentIntent.body) as { date: string; time: string };
    return <><StepHeader title="Создание записи" caption="Повторная попытка проверит результат того же запроса." step={7}/><div className="content-card" role={createError ? "alert" : "status"}><h3>{creating ? "Сохраняем запись…" : "Проверим результат"}</h3><p>Исходный визит: {formatSalonDate(original.date)}, {original.time}. Повтор сохранит его условия, даже если вы изменили выбор.</p><p>{createError??"Не закрывайте страницу до получения личной ссылки."}</p><button className="primary-button full-width" disabled={creating} onClick={proceed}>{creating ? "Пожалуйста, подождите…" : "Повторить запрос"}</button>{canEdit && <button className="secondary-button stage-link" onClick={()=>{clearAppointmentIntent();setCreateError(null);setCheckedBody(null);setError(null);setAttempt(value=>value+1);}}>Проверить выбор заново</button>}</div></>;
  }
  return <><StepHeader title="Всё ли верно?" caption="Проверьте детали перед сохранением записи." step={6} back="/contacts"/><DemoNotice/>{checkedQuote ? <QuoteSummary quote={checkedQuote} editable/> : error ? <div className="empty-state" role="alert"><Info size={26}/><h3>Не удалось проверить запись</h3><p>{error}</p><button className="secondary-button" onClick={() => { setError(null); setCheckedBody(null); setAttempt(value => value + 1); }}><RefreshCw size={16}/>Попробовать снова</button><Link href="/time" className="secondary-button stage-link">Изменить время</Link><button className="secondary-button stage-link" onClick={reload}>Обновить каталог и условия</button></div> : <div className="content-card" role="status">Проверяем услуги, контакты и доступность…</div>}
    {createError && <p className="form-error-summary" role="alert">{createError}</p>}
    {checkedQuote && <p className="schedule-caption">Все суммы и доступность проверены сервером по актуальным условиям мастера. {salon.policy.prepaymentMode === "DISABLED" ? "Предоплата отключена." : "Деньги в этом сценарии не списываются."}</p>}
    <FlowActions back="/contacts" onNext={proceed} disabled={!checkedQuote || creating} label={checkedQuote?.prepaymentMinor === 0 ? "Подтвердить запись" : "Забронировать время"}/></>;
}

