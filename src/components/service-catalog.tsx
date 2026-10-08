"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Clock3, Plus, Search, Scissors, Sparkles, X } from "lucide-react";
import { useBooking } from "./booking-provider";
import { CatalogState, EmptyCatalog } from "./catalog-state";
import { StepHeader } from "./site-shell";
import { money, duration, servicesCount } from "@/lib/format";
import type { Service } from "@/lib/types";
import { DraftNotice } from "./booking-flow-common";

function ServiceCard({ service }: { service: Service }) {
  const { salon, selected, toggle } = useBooking();
  const choice = selected.find(item => item.service.id === service.id);
  const [variantId, setVariantId] = useState(service.variants[0].id);
  const variant = choice?.variant ?? service.variants.find(item => item.id === variantId) ?? service.variants[0];
  const [expanded, setExpanded] = useState(false);
  return <article className={`service-card ${choice ? "is-selected" : ""}`}>
    <div className="service-main"><div className="service-copy"><div className="service-title"><h4>{service.name}</h4>{service.popular && <span className="popular-tag"><Sparkles size={10}/>Популярное</span>}</div><p>{service.description}</p><div className="service-meta"><span><Clock3 size={12}/>{duration(variant.durationMinutes)}</span><button className="details-button" aria-expanded={expanded} aria-controls={`details-${service.id}`} onClick={() => setExpanded(value => !value)}>Подробнее<ChevronDown size={12} className={expanded ? "rotated" : ""}/></button></div></div><div className="service-action"><strong>{money(variant.priceMinor, salon.currency)}</strong><button className={`select-service ${choice ? "selected" : ""}`} aria-label={`${choice ? "Убрать" : "Выбрать"}: ${service.name}`} aria-pressed={Boolean(choice)} onClick={() => toggle(variant.id)}>{choice ? <Check size={18}/> : <Plus size={18}/>}</button></div></div>
    {service.variants.length > 1 && <div className="variant-control"><label htmlFor={`variant-${service.id}`}>Вариант услуги</label><select id={`variant-${service.id}`} value={variant.id} onChange={event => { setVariantId(event.target.value); if (choice) toggle(event.target.value); }}>{service.variants.map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.priceMinor, salon.currency)} · {duration(item.durationMinutes)}</option>)}</select></div>}
    {expanded && <p className="service-details" id={`details-${service.id}`}>{service.details}</p>}
  </article>;
}
export function BookingSummary() {
  const { salon, selected, totalPrice, totalMinutes, remove } = useBooking();
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!panelRef.current) return;
    const observer = new ResizeObserver(entries => {
      const height = entries[0].borderBoxSize[0]?.blockSize ?? entries[0].contentRect.height;
      document.documentElement.style.setProperty("--summary-height", `${height}px`);
    });
    observer.observe(panelRef.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--summary-height"); };
  }, []);
  return <aside ref={panelRef} className="booking-summary" aria-label="Выбранные услуги"><div className="summary-inner">
    {expanded && selected.length > 0 && <div className="selected-list"><div className="selected-list-heading"><b>Ваш выбор</b><button aria-label="Свернуть список" onClick={() => setExpanded(false)}><ChevronDown size={18}/></button></div>{selected.map(item => <div key={item.service.id}><span>{item.service.name}{item.service.variants.length > 1 && <small>{item.variant.name}</small>}</span><b>{money(item.variant.priceMinor, salon.currency)}</b><button onClick={() => remove(item.service.id)} aria-label={`Убрать из списка: ${item.service.name}`}><X size={15}/></button></div>)}</div>}
    <div className="summary-row"><div className="summary-price">{selected.length ? <><button onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{servicesCount(selected.length)}<ChevronDown size={12} className={expanded ? "rotated" : ""}/><span>· {duration(totalMinutes)}</span></button><strong aria-live="polite">{money(totalPrice, salon.currency)}</strong></> : <><small>Начнём с вашего выбора</small><strong className="empty-total">Выберите услугу</strong></>}</div>{selected.length ? <Link className="primary-button" href="/masters">Продолжить<ArrowRight size={17}/></Link> : <button className="primary-button" disabled>Продолжить<ArrowRight size={17}/></button>}</div><p className="summary-note">{selected.length ? "Далее — знакомство с мастерами" : "Можно выбрать несколько услуг"}</p>
  </div></aside>;
}
export function ServiceCatalog() {
  const { catalog, loading, error, selected } = useBooking();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  const filtered = (catalog?.services ?? []).filter(service => (category === "all" || service.categoryId === category) && `${service.name} ${service.description}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru").trim()) && (!onlySelected || selected.some(item => item.service.id === service.id)));
  return <><StepHeader title="Время для себя" caption="Выберите то, что хочется. Остальное мы берём на себя."/><DraftNotice/><section aria-label="Каталог услуг"><div className="search-wrap"><Search size={18}/><input type="search" placeholder="Найти свою услугу" aria-label="Поиск услуг" maxLength={100} value={search} onChange={event => setSearch(event.target.value)}/>{search && <button aria-label="Очистить поиск" onClick={() => setSearch("")}><X size={17}/></button>}</div>
    <div className="category-filters" aria-label="Категории услуг"><button className={category === "all" ? "active" : ""} aria-pressed={category === "all"} onClick={() => setCategory("all")}>Все услуги</button>{(catalog?.categories ?? []).slice(0, filterOpen ? undefined : 3).map(item => <button key={item.id} className={category === item.id ? "active" : ""} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.name}</button>)}{catalog && catalog.categories.length > 3 && <button className="more-filters" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value); if (filterOpen && catalog.categories.slice(3).some(item => item.id === category)) setCategory("all"); }}>{filterOpen ? "Свернуть" : "Ещё"}<ChevronDown size={13} className={filterOpen ? "rotated" : ""}/></button>}</div>
    <div className="catalog-toolbar"><span>{loading ? "Загружаем каталог" : `${filtered.length} ${filtered.length === 1 ? "услуга" : filtered.length > 1 && filtered.length < 5 ? "услуги" : "услуг"}`}<span className="tiny-dot"/>{catalog?.isDemo ? "Демо-каталог" : "Каталог салона"}</span><button onClick={() => setOnlySelected(value => !value)} className={onlySelected ? "active" : ""} aria-pressed={onlySelected}>Мой выбор{selected.length > 0 && <b>{selected.length}</b>}</button></div>
    {(loading || error) ? <CatalogState/> : filtered.length === 0 ? <EmptyCatalog reset={() => { setSearch(""); setCategory("all"); setOnlySelected(false); }}/> : <div className="service-groups">{catalog?.categories.map(item => {
      const services = filtered.filter(service => service.categoryId === item.id);
      if (!services.length) return null;
      return <section className="service-group" key={item.id}><div className="group-heading"><span className="group-icon">{(item.slug ?? item.id) === "cuts" || (item.slug ?? item.id) === "beard" ? <Scissors size={16}/> : <Sparkles size={16}/>}</span><div><h3>{item.name}</h3><p>{item.description}</p></div><span className="group-count">{services.length}</span></div><div className="services-card">{services.map(service => <ServiceCard key={service.id} service={service}/>)}</div></section>;
    })}</div>}
  </section><BookingSummary/></>;
}

