"use client";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Info, Scissors, X } from "lucide-react";
import { useBooking } from "./booking-provider";
import { CatalogState } from "./catalog-state";
import { duration, money, servicesCount } from "@/lib/format";

export function DemoNotice({ children }: { children?: React.ReactNode }) {
  return <div className="inline-note demo-flow-note"><Info size={17}/><span>{children ?? "Доступность проверена по расписанию мастера. При продолжении запись сохранится в базе: с предоплатой время будет временно забронировано, без неё — запись подтверждена."}</span></div>;
}
export function DraftNotice() {
  const { notice, dismissNotice } = useBooking();
  return notice ? <div className="draft-notice" role="status"><Info size={17}/><span>{notice}</span><button onClick={dismissNotice} aria-label="Закрыть пояснение"><X size={16}/></button></div> : null;
}
export function SelectionSummary() {
  const { selected, master, totalPrice, totalMinutes, salon } = useBooking();
  return <div className="selection-summary"><Scissors size={17}/><span>{master?.name ?? "Ваш выбор"}<small>{servicesCount(selected.length)} · {duration(totalMinutes)}</small></span><b>{money(totalPrice, salon.currency)}</b></div>;
}
export function FlowActions({ back, next, disabled = false, onNext, label = "Продолжить" }: { back: string; next?: string; disabled?: boolean; onNext?: () => void; label?: string }) {
  return <div className="flow-actions"><Link className="secondary-button" href={back}><ArrowLeft size={15}/>Назад</Link>{onNext ? <button type="button" className="primary-button" disabled={disabled} onClick={onNext}>{label}<ArrowRight size={16}/></button> : !next ? null : disabled ? <button type="button" className="primary-button" disabled>{label}<ArrowRight size={16}/></button> : <Link className="primary-button" href={next}>{label}<ArrowRight size={16}/></Link>}</div>;
}
export function BookingGuard({ requiring, children }: { requiring: "services" | "master" | "date" | "time" | "contacts" | "quote"; children: React.ReactNode }) {
  const booking = useBooking();
  // A pending request keeps its original body even when the draft changes.
  // Recovery and an already saved appointment must not depend on the catalog.
  if (requiring === "contacts" && (booking.pendingAppointmentIntent || booking.appointment)) return <><DraftNotice/>{children}</>;
  if (booking.loading || booking.error) return <CatalogState/>;
  let missing: { href: string; title: string; text: string } | null = null;
  if (!booking.selected.length) missing = { href: "/", title: "Сначала выберите услуги", text: "Для продолжения нужна хотя бы одна услуга. Черновик сохраняется при переходах внутри сайта, а при перезагрузке очищается." };
  else if (requiring !== "services" && !booking.master) missing = { href: "/masters", title: "Выберите своего мастера", text: "Покажем мастеров, которые выполняют все выбранные услуги." };
  else if (["date", "time", "contacts", "quote"].includes(requiring) && !booking.date) missing = { href: "/date", title: "Нужна дата визита", text: "Выберите доступный день в расписании мастера." };
  else if (["time", "contacts", "quote"].includes(requiring) && !booking.time) missing = { href: "/time", title: "Выберите удобное время", text: "Для продолжения нужно время начала всей процедуры." };
  else if (["contacts", "quote"].includes(requiring) && (!booking.contacts.name || !booking.contacts.phone || !booking.consent)) missing = { href: "/contacts", title: "Оставьте контактные данные", text: "Заполните имя, телефон и ознакомьтесь с демонстрационными условиями." };
  else if (requiring === "quote" && !booking.quote) missing = { href: "/review", title: "Проверьте запись заново", text: "После изменения выбора итог нужно повторно проверить на сервере." };
  if (missing) return <div className="empty-state"><h2>{missing.title}</h2><p>{missing.text}</p><Link className="primary-button" href={missing.href}>Вернуться к выбору<ArrowRight size={16}/></Link></div>;
  return <><DraftNotice/>{children}</>;
}
