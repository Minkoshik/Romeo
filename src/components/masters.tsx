"use client";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Scissors } from "lucide-react";
import { DemoNotice, DraftNotice, FlowActions } from "./booking-flow-common";
import { useBooking } from "./booking-provider";
import { CatalogState } from "./catalog-state";
import { StepHeader } from "./site-shell";
import { duration, money, servicesCount } from "@/lib/format";
import { masterCanPerform } from "@/lib/catalog-rules";

export function Masters() {
  const { catalog, loading, error, reload, selected, salon, totalMinutes, totalPrice, totalBuffer, basePrice, baseMinutes, master: chosen, chooseMaster } = useBooking();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const selectedItems = selected.map(item => ({ serviceId: item.service.id, variantId: item.variant.id }));
  const masters = catalog?.masters.filter(master => !selected.length || masterCanPerform(master, selectedItems)) ?? [];
  function selectMaster(id: string) {
    requestRef.current?.abort(); setChecking(false); setSelectionError(null); chooseMaster(id);
  }
  async function proceed() {
    if (!chosen || checking) return;
    const controller = new AbortController(); requestRef.current = controller;
    setChecking(true); setSelectionError(null);
    try {
      const response = await fetch("/api/catalog/selection", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantIds: selected.map(item => item.variant.id), masterId: chosen.id }), signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) { setSelectionError(result.error ?? "Не удалось проверить выбор. Повторите попытку."); return; }
      if (result.totalPriceMinor !== totalPrice || result.totalDurationMinutes !== totalMinutes || result.totalBufferMinutes !== totalBuffer) {
        setSelectionError("Условия услуг изменились. Каталог обновлён: проверьте итог и выберите мастера заново."); reload(); return;
      }
      router.push("/date");
    } catch { if (!controller.signal.aborted) setSelectionError("Не удалось проверить выбор. Проверьте соединение и повторите попытку."); }
    finally { if (!controller.signal.aborted) setChecking(false); }
  }
  return <><StepHeader title="Хорошие руки" caption={selected.length ? "Эти мастера выполняют все выбранные вами услуги." : "Познакомьтесь с нашей командой и найдите своего мастера."} step={2} back="/"/>
    <DraftNotice/><DemoNotice>Один мастер выполняет все выбранные услуги последовательно. Его условия учитываются при расчёте времени и стоимости.</DemoNotice>
    {selected.length > 0 && <div className="selection-preview"><Scissors size={16}/><span>{servicesCount(selected.length)} · {duration(totalMinutes)}</span><b>{money(totalPrice, salon.currency)}</b><Link href="/">Изменить</Link></div>}
    {loading || error ? <CatalogState/> : masters.length === 0 ? <div className="empty-state"><Scissors size={26}/><h3>Для этого набора нет мастера</h3><p>Попробуйте изменить выбранные услуги.</p><Link href="/" className="secondary-button">Изменить услуги<ArrowLeft size={16}/></Link></div> : <div className="masters-list">{masters.map(master => {
      const price = selected.reduce((sum, item) => sum + (master.overrides?.[item.variant.id]?.priceMinor ?? catalog!.services.find(service => service.id === item.service.id)!.variants.find(variant => variant.id === item.variant.id)!.priceMinor), 0);
      const minutes = selected.reduce((sum, item) => sum + (master.overrides?.[item.variant.id]?.durationMinutes ?? catalog!.services.find(service => service.id === item.service.id)!.variants.find(variant => variant.id === item.variant.id)!.durationMinutes), 0);
      return <article key={master.id} className={`master-card ${chosen?.id === master.id ? "is-selected" : ""}`}><div className="master-top"><div className={`master-avatar ${master.color}`} aria-label={master.photoUrl?`Фото: ${master.name}`:"Заглушка фото"}>{master.photoUrl?<Image src={master.photoUrl} alt={master.name} width={64} height={64} unoptimized/>:<>{master.initials}<span><Scissors size={12}/></span></>}</div><div><span className="eyebrow">КОМАНДА {salon.name}{master.isDemo ? " · ДЕМО" : ""}</span><h3>{master.name}</h3><p>{master.specialty}</p></div><button className={`select-service ${chosen?.id === master.id ? "selected" : ""}`} disabled={!selected.length} aria-label={`Выбрать мастера: ${master.name}`} aria-pressed={chosen?.id === master.id} onClick={() => selectMaster(master.id)}>{chosen?.id === master.id ? <Check size={18}/> : <ArrowRight size={17}/>}</button></div><p className="master-description">{master.description}</p>{selected.length > 0 && <div className="master-price"><b>{money(price, salon.currency)}</b><span>{duration(minutes)}</span>{(price !== basePrice || minutes !== baseMinutes) && <small>Индивидуальные условия мастера</small>}</div>}<div className="master-services">{catalog?.services.filter(service => master.serviceIds.includes(service.id)).map(service => <span key={service.id}>{service.name}</span>)}</div></article>;
    })}</div>}
    {chosen && <div className="success-note" role="status"><Check size={17}/><span>Выбран {chosen.name}. Итог: {money(totalPrice, salon.currency)}, {duration(totalMinutes)}.{(totalPrice !== basePrice || totalMinutes !== baseMinutes) && <small>У мастера другие цена или длительность: вместо {money(basePrice, salon.currency)} / {duration(baseMinutes)}.</small>}</span></div>}
    {selectionError && <div className="inline-note" role="alert"><span>{selectionError}<button className="secondary-button stage-link" onClick={reload}>Обновить каталог</button></span></div>}
    {selected.length ? <FlowActions back="/" onNext={proceed} disabled={!chosen || checking} label={checking ? "Проверяем выбор…" : "Продолжить"}/> : <Link href="/" className="primary-button full-width stage-link">Выбрать услуги<ArrowRight size={17}/></Link>}
  </>;
}

