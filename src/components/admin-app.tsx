"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AdminActor } from "@/lib/admin-auth";
import type { AdminCatalog, AdminSchedule } from "@/lib/admin-catalog-repository";
import type { AdminAppointmentView, getAdminAppointments } from "@/lib/admin-booking-repository";
import type { getAdminManagement } from "@/lib/admin-management-repository";
import { CatalogEditor, FieldsForm, ScheduleEditor, SettingsEditor, type AdminMutate } from "./admin-editors";
import { salonTimeParts } from "@/lib/salon-time";
import { adminCalendarRange } from "@/lib/admin-calendar-range";

type Management = Awaited<ReturnType<typeof getAdminManagement>>;
type Calendar = Awaited<ReturnType<typeof getAdminAppointments>>;
type Section="overview"|"appointments"|"catalog"|"masters"|"schedule"|"customers"|"payments"|"settings"|"audit";
const sections:{id:Section;label:string}[]=[{id:"overview",label:"Обзор"},{id:"appointments",label:"Календарь"},{id:"catalog",label:"Услуги"},{id:"masters",label:"Мастера"},{id:"schedule",label:"Расписание"},{id:"customers",label:"Клиенты"},{id:"payments",label:"Платежи"},{id:"settings",label:"Настройки"},{id:"audit",label:"Журнал"}];
const statuses:Record<string,string>={WAITING_PAYMENT:"Ожидает оплаты",CONFIRMED:"Подтверждена",COMPLETED:"Завершена",CANCELLED:"Отменена",NO_SHOW:"Неявка",EXPIRED:"Бронь истекла",PENDING:"Ожидает оплаты",SUCCEEDED:"Успешен",FAILED:"Ошибка",PARTIALLY_REFUNDED:"Частичный возврат",REFUNDED:"Возврат"};
const money=(n:number,c:string)=>new Intl.NumberFormat("ru-RU",{style:"currency",currency:c}).format(n/100);
const moment=(value:string,zone:string)=>new Intl.DateTimeFormat("ru-RU",{timeZone:zone,dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
async function jsonRequest(url:string,body?:unknown){
  const response=await fetch(url,{cache:"no-store",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(response.status===401)throw new Error("Сеанс завершён. Войдите снова через страницу входа.");
  if(!response.ok)throw new Error(result.error??"Не удалось выполнить операцию.");return result;
}
export function AdminApp({admin,today}:{admin:AdminActor;today:string}) {
  const router=useRouter();
  const intent=useRef<{fingerprint:string;key:string}|null>(null);
  const inFlight=useRef(false);
  const [section,setSection]=useState<Section>("overview");const [data,setData]=useState<unknown>(null);const [catalog,setCatalog]=useState<AdminCatalog|null>(null);
  const [error,setError]=useState("");const [message,setMessage]=useState("");const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [revision,setRevision]=useState(0);
  const [date,setDate]=useState(today);const [view,setView]=useState("day");const [masterId,setMasterId]=useState("");const [status,setStatus]=useState("");const [search,setSearch]=useState("");const [customerId,setCustomerId]=useState("");const [attention,setAttention]=useState(false);
  useEffect(()=>{let active=true;const query=new URLSearchParams({section:section==="masters"?"catalog":section});
    const range=adminCalendarRange(date,view);
    if(section==="appointments"&&range){query.set("from",range.from);query.set("to",range.to);if(masterId)query.set("masterId",masterId);if(status)query.set("status",status);}
    if(section==="schedule"&&masterId)query.set("masterId",masterId);
    if(section==="customers"){if(search)query.set("search",search);if(customerId)query.set("id",customerId);}
    if(section==="payments"&&attention)query.set("needsAttention","true");
    async function load(){setLoading(true);setError("");try{
      if(section==="appointments"&&!range){setData(null);throw new Error("Укажите корректную начальную дату.");}
      const nextCatalog=await jsonRequest("/api/admin/data?section=catalog") as AdminCatalog;
      if(!active)return;setCatalog(nextCatalog);
      if(section==="schedule"&&!masterId){setData(null);return;}
      const result=await jsonRequest("/api/admin/data?"+query);if(active)setData(result);
    }catch(e){if(active)setError(e instanceof Error&&!(e instanceof TypeError)?e.message:"Сервер недоступен. Повторите попытку.");}finally{if(active)setLoading(false);}}
    void load();return()=>{active=false;};
  },[section,date,view,masterId,status,search,customerId,attention,revision]);
  const mutate:AdminMutate=async(target,input)=>{if(inFlight.current)return;inFlight.current=true;const fingerprint=JSON.stringify({target,input});if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:crypto.randomUUID()};setBusy(true);setError("");setMessage("");try{await jsonRequest("/api/admin/mutate",{target,input:{...input,idempotencyKey:intent.current.key}});intent.current=null;setMessage("Изменения сохранены.");setRevision(r=>r+1);}catch(e){setError(e instanceof Error&&!(e instanceof TypeError)?e.message:"Соединение прервалось. Повторите действие с теми же данными.");}finally{inFlight.current=false;setBusy(false);}};
  return <div className="admin-shell"><header className="admin-header"><Link href="/" className="brand">РОМЕО</Link><div><strong>Управление салоном</strong><small>{admin.name} · {admin.role==="OWNER"?"владелец":"администратор"}</small></div><button className="secondary-button" onClick={async()=>{try{await jsonRequest("/api/admin/logout",{});router.replace("/admin/login");router.refresh();}catch(e){setError(e instanceof Error?e.message:"Не удалось выйти.");}}}>Выйти</button></header>
    <nav className="admin-nav" aria-label="Разделы управления">{sections.map(s=><button key={s.id} aria-current={section===s.id?"page":undefined} onClick={()=>{if(section===s.id)return;setSection(s.id);setMessage("");setData(null);}}>{s.label}</button>)}</nav>
    <div className="admin-main"><div className="admin-heading"><h1>{sections.find(s=>s.id===section)?.label}</h1><button className="secondary-button" onClick={()=>setRevision(r=>r+1)}>Обновить</button></div>
      {error&&<p role="alert" className="admin-error">{error}</p>}{message&&<p role="status" className="admin-success">{message}</p>}{busy&&<p role="status">Сохраняем изменения…</p>}
      {section==="appointments"&&<div className="admin-filters"><label>Начальная дата<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>Вид<select value={view} onChange={e=>setView(e.target.value)}><option value="day">День</option><option value="week">Неделя</option><option value="month">Месяц</option></select></label><label>Мастер<select value={masterId} onChange={e=>setMasterId(e.target.value)}><option value="">Все мастера</option>{catalog?.masters.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Статус<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">Все статусы</option>{Object.entries(statuses).filter(([k])=>["WAITING_PAYMENT","CONFIRMED","COMPLETED","CANCELLED","NO_SHOW","EXPIRED"].includes(k)).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label></div>}
      {section==="schedule"&&<label>Мастер<select value={masterId} onChange={e=>setMasterId(e.target.value)}><option value="">Выберите мастера</option>{catalog?.masters.filter(m=>!m.archivedAt).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      {section==="customers"&&<div className="admin-filters"><label>Поиск по имени, телефону или email<input value={search} onChange={e=>{setSearch(e.target.value);setCustomerId("");}} maxLength={120}/></label>{customerId&&<button className="secondary-button" onClick={()=>setCustomerId("")}>Все клиенты</button>}</div>}
      {section==="payments"&&<label className="admin-row"><input type="checkbox" checked={attention} onChange={e=>setAttention(e.target.checked)}/>Только требующие внимания</label>}
      {loading?<p role="status">Загружаем данные…</p>:<fieldset className="admin-content" disabled={busy}>
        {section==="overview"&&!!data&&<Overview data={data as Extract<Management,{today:string}>} mutate={mutate} catalog={catalog}/>}
        {section==="appointments"&&!!data&&<><p>Время салона: {(data as Calendar).timezone}. Стоимость при переносе сохраняется, разница — 0. Оплата остаётся связанной с записью.</p>{catalog&&<ManualBooking catalog={catalog} date={date} mutate={mutate}/>}<AppointmentList appointments={(data as Calendar).appointments} mutate={mutate} catalog={catalog}/>{(data as Calendar).truncated&&<p>Показаны первые 500 записей. Сократите период.</p>}</>}
        {(section==="catalog"||section==="masters")&&catalog&&<CatalogEditor key={revision+section} catalog={catalog} mutate={mutate} mastersOnly={section==="masters"}/>}
        {section==="schedule"&&(data?<ScheduleEditor key={revision+masterId} schedule={data as AdminSchedule} mutate={mutate}/>:<p>Выберите мастера для настройки графика.</p>)}
        {section==="customers"&&!!data&&<Customers data={data as Extract<Management,{customers:unknown}>} mutate={mutate} select={setCustomerId} catalog={catalog}/>}
        {section==="payments"&&!!data&&<Payments data={data as Extract<Management,{payments:unknown}>} mutate={mutate}/>}
        {section==="settings"&&!!data&&<SettingsEditor key={revision} settings={(data as Extract<Management,{settings:unknown}>).settings!} mutate={mutate} owner={admin.role==="OWNER"}/>}
        {section==="audit"&&!!data&&<Audit data={data as Extract<Management,{audit:unknown}>}/>}
      </fieldset>}
    </div></div>;
}
function AppointmentList({appointments,mutate,catalog}:{appointments:AdminAppointmentView[];mutate:AdminMutate;catalog:AdminCatalog|null}){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const interval=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(interval);},[]);
  if(!appointments.length)return <p className="admin-empty">Записей в этом периоде нет.</p>;
  return <div className="admin-appointments">{appointments.map(a=><details className="admin-entity" key={a.id+ a.updatedAt}><summary><span>№{a.number} · {moment(a.startsAt,a.timezone)}</span><strong>{a.customerName} · {a.masterName}</strong><span>{statuses[a.status]} · {money(a.totalPriceMinor,a.currency)}</span></summary><div className="admin-detail"><p>{a.customerPhone} · {a.customerEmail}</p><p>{a.items.map(i=>i.serviceName+" · "+i.variantName).join(", ")}</p><p>{a.totalDurationMinutes} мин + перерыв {a.totalBufferMinutes} мин · внесено {money(a.paidMinor,a.currency)} · остаток {money(a.remainingMinor,a.currency)}</p><p>Комментарий клиента: {a.customerComment||"—"}</p>
    <FieldsForm fields={[{name:"adminNotes",label:"Заметки администратора",type:"textarea"}]} values={{adminNotes:a.adminNotes}} onSave={d=>mutate("appointment",{action:"notes",id:a.id,expectedUpdatedAt:a.updatedAt,...d})}/>
    {["CONFIRMED","WAITING_PAYMENT"].includes(a.status)&&<><details><summary>Перенести запись</summary><FieldsForm fields={[{name:"masterId",label:"Мастер",type:"select",options:catalog?.masters.filter(m=>m.isBookable&&!m.archivedAt).map(m=>({value:m.id,label:m.name}))},{name:"date",label:"Дата",type:"date",required:true},{name:"time",label:"Время",type:"time",required:true},{name:"reason",label:"Причина переноса",required:true}]} values={{masterId:a.masterId,...salonTimeParts(new Date(a.startsAt),a.timezone)}} onSave={d=>mutate("appointment",{action:"reschedule",id:a.id,expectedUpdatedAt:a.updatedAt,...d})}/></details><details><summary>Отменить запись</summary><FieldsForm fields={[{name:"reason",label:"Причина отмены",required:true}]} label="Отменить запись" onSave={d=>mutate("appointment",{action:"cancel",id:a.id,expectedUpdatedAt:a.updatedAt,...d})}/><p>Внесённая оплата сохраняется. Возврат потребует проверки салоном.</p></details></>}
    {a.status==="CONFIRMED"&&<div className="admin-row"><button className="secondary-button" disabled={Date.parse(a.endsAt)>now} onClick={()=>void mutate("appointment",{action:"status",id:a.id,expectedUpdatedAt:a.updatedAt,status:"COMPLETED"})}>Завершить визит</button><button className="secondary-button" disabled={Date.parse(a.startsAt)>now} onClick={()=>void mutate("appointment",{action:"status",id:a.id,expectedUpdatedAt:a.updatedAt,status:"NO_SHOW"})}>Клиент не пришёл</button></div>}
  </div></details>)}</div>;
}
function ManualBooking({catalog,date,mutate}:{catalog:AdminCatalog;date:string;mutate:AdminMutate}){
  const [variants,setVariants]=useState<string[]>([]);
  return <details className="admin-entity"><summary>Создать запись вручную</summary><div className="admin-checks">{catalog.services.filter(s=>s.isActive&&!s.archivedAt).flatMap(s=>s.variants.filter(v=>v.isActive&&!v.archivedAt).map(v=><label key={v.id}><input type="checkbox" checked={variants.includes(v.id)} onChange={e=>setVariants(e.target.checked?[...variants,v.id]:variants.filter(id=>id!==v.id))}/>{s.name} · {v.name} · {money(v.priceMinor,catalog.currency)}</label>))}</div>
    <FieldsForm fields={[{name:"masterId",label:"Мастер",type:"select",options:catalog.masters.filter(m=>m.isBookable&&!m.archivedAt).map(m=>({value:m.id,label:m.name}))},{name:"date",label:"Дата",type:"date",required:true},{name:"time",label:"Время",type:"time",required:true},{name:"name",label:"Имя клиента",required:true},{name:"phone",label:"Телефон клиента",required:true},{name:"email",label:"Email"},{name:"comment",label:"Комментарий клиента"},{name:"adminNotes",label:"Заметки администратора",type:"textarea"},{name:"consent",label:"Клиент согласен с условиями записи и обработкой данных",type:"checkbox"},{name:"confirmWithoutPayment",label:"Подтвердить без внесённой предоплаты",type:"checkbox"},{name:"reason",label:"Причина подтверждения без предоплаты"}]} values={{date}} label="Создать запись" onSave={d=>mutate("appointment",{action:"create",variantIds:variants,masterId:d.masterId,date:d.date,time:d.time,contacts:{name:d.name,phone:d.phone,email:d.email,comment:d.comment},adminNotes:d.adminNotes,consent:d.consent,confirmWithoutPayment:d.confirmWithoutPayment,...(d.reason?{reason:d.reason}:{})})}/><p>Мастер, цена и свободный интервал проверяются сервером. Подтверждение без предоплаты не создаёт платёж.</p></details>;
}
function Overview({data,mutate,catalog}:{data:Extract<Management,{today:string}>;mutate:AdminMutate;catalog:AdminCatalog|null}){
  return <><p>{data.today} · {data.timezone}</p><div className="admin-stats"><article><strong>{data.confirmedCount}</strong><span>Подтверждённых на сегодня</span></article><article><strong>{data.attentionCount}</strong><span>Платежей требуют внимания</span></article><article><strong>{data.prepayments?.map(p=>money(p.amountMinor,p.currency)+" · "+p.mode).join(", ")||"0"}</strong><span>Предоплаты, полученные сегодня</span></article></div><h2>Сегодня</h2><AppointmentList appointments={data.appointments!} mutate={mutate} catalog={catalog}/><h2>Ближайшие подтверждённые визиты</h2><AppointmentList appointments={data.next!} mutate={mutate} catalog={catalog}/></>;
}
function Customers({data,mutate,select,catalog}:{data:Extract<Management,{customers:unknown}>;mutate:AdminMutate;select:(id:string)=>void;catalog:AdminCatalog|null}){
  return <>{!data.customers?.length&&<p>Клиенты не найдены.</p>}{data.customers?.map(c=><details className="admin-entity" key={c.id+c.updatedAt}><summary>{c.name} · {c.phoneNormalized} · записей: {c._count.appointments}</summary><p>{c.email||"Email не указан"}</p><FieldsForm fields={[{name:"adminNotes",label:"Приватные заметки",type:"textarea"}]} values={{adminNotes:c.adminNotes}} onSave={d=>mutate("management",{action:"customerNotes",id:c.id,expectedUpdatedAt:c.updatedAt,...d})}/><button className="secondary-button" onClick={()=>select(c.id)}>История визитов и отмен</button></details>)}{!!data.history?.length&&<><h2>История клиента</h2><AppointmentList appointments={data.history} mutate={mutate} catalog={catalog}/></>}{data.truncated&&<p>Первые 100 клиентов. Уточните поиск.</p>}</>;
}
function Payments({data,mutate}:{data:Extract<Management,{payments:unknown}>;mutate:AdminMutate}){
  return <><p>TEST — тестовые суммы. Возвраты выполняются через провайдера после его подключения; отметка проверки не меняет оплату.</p>{!data.payments?.length&&<p>Платежей нет.</p>}{data.payments?.map(p=><details className="admin-entity" key={p.id+p.updatedAt}><summary>№{p.appointment.number} · {p.appointment.customerNameSnapshot} · {money(p.amountMinor,p.currency)} · {statuses[p.status]} · {p.mode}{p.needsAttention?" · Требует внимания":""}</summary><p>Провайдер: {p.provider} · ID: {p.providerPaymentId||"—"}</p><p>Возвращено: {money(p.refundedAmountMinor,p.currency)} · {p.refundedAt||"Возврата нет"}</p><p>{p.attentionReason||p.failureCode||"Проблем не отмечено"}</p><FieldsForm fields={[{name:"note",label:"Результат проверки / следующий шаг",type:"textarea",required:true}]} onSave={d=>mutate("management",{action:"paymentReview",id:p.id,expectedUpdatedAt:p.updatedAt,...d})}/></details>)}{data.truncated&&<p>Показаны последние 200 платежей.</p>}</>;
}
function Audit({data}:{data:Extract<Management,{audit:unknown}>}){return <><p>Последние 200 событий. Доступно только администраторам.</p>{data.audit?.map(a=><details className="admin-entity" key={a.id}><summary>{new Date(a.createdAt).toLocaleString("ru-RU")} · {a.actor?.name??"Система"} · {a.action}</summary><p>{a.entityType} · {a.entityId}</p><pre>{JSON.stringify(a.changes,null,2)}</pre></details>)}{!data.audit?.length&&<p>Событий пока нет.</p>}</>;}
