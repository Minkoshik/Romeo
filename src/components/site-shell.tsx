"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Clock3, Mail, MapPin, Phone, Scissors, ShieldCheck } from "lucide-react";
import { useBooking } from "./booking-provider";
import type { ReactNode } from "react";

export function SiteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return <div className={pathname.startsWith("/admin") ? "admin-container" : "page-container"}>{children}</div>;
}

export function SkipLink() {
  return <a className="skip-link" href="#main" onClick={event => {
    const main = document.getElementById("main");
    if (!main) return;
    // Preserve the private appointment token held in the URL fragment.
    event.preventDefault();
    main.focus({ preventScroll: true });
    main.scrollIntoView();
  }}>Перейти к содержимому</a>;
}

export function Brand({ small = false }: { small?: boolean }) {
  const { salon } = useBooking();
  return <span className={`brand ${small ? "brand-small" : ""}`}>{salon.logoUrl?<Image src={salon.logoUrl} alt="" width={36} height={36} unoptimized/>:<Scissors aria-hidden="true"/>}<span>{salon.name}<span className="brand-sub">САЛОН & БАРБЕРШОП</span></span></span>;
}
export function SiteHeader() {
  const pathname = usePathname();
  const { salon } = useBooking();
  if (pathname.startsWith("/admin")) return null;
  return <><header className="site-header"><div className="site-header-inner"><Link href="/" aria-label={`${salon.name} — главная`}><Brand small/></Link><span className="demo-badge"><span/>Демо-версия</span></div></header>
    <div className="salon-card"><div className="salon-image"><Image src="/salon.jpg" alt="Работа барбера — демонстрационное фото" width={1200} height={600} sizes="(max-width: 639px) calc(100vw - 32px), 600px" priority/><div className="image-shade"/><span className="image-caption">МЕСТО, ГДЕ МОЖНО БЫТЬ СОБОЙ</span><span className="image-mark">{salon.name.charAt(0)}.</span></div><div className="salon-info"><div><div className="eyebrow">САЛОН КРАСОТЫ И БАРБЕРШОП</div><h1>{salon.name}<span className="salon-name-dot">.</span></h1><p><MapPin size={14} aria-hidden="true"/>{salon.address}</p></div><Link className="salon-info-link" href="/about" aria-label="Информация о салоне"><ArrowUpRight size={20}/></Link></div>
      <nav className="main-nav" aria-label="Основная навигация">{[{ href: "/", label: "Услуги" }, { href: "/masters", label: "Мастера" }, { href: "/about", label: "О салоне" }].map(item => <Link key={item.href} href={item.href} className={pathname === item.href ? "active" : ""} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}</nav>
    </div></>;
}
export function StepHeader({ title, caption, step = 1, back }: { title: string; caption: string; step?: number; back?: string }) {
  return <div className="step-header">{back && <Link className="back-link" href={back}><ArrowLeft size={15}/>Назад</Link>}<div className="step-heading"><div><div className="eyebrow">ОНЛАЙН-ЗАПИСЬ</div><h2>{title}</h2></div><span className="step-count">Шаг <b>{step}</b> из 8</span></div><div className="step-track" aria-label={`Шаг ${step} из 8`}>{Array.from({length: 8}, (_, index) => <span key={index} className={index < step ? "done" : ""}/>)}</div><p>{caption}</p></div>;
}
export function SiteFooter() {
  const { salon } = useBooking();
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;
  return <footer className="site-footer"><p><ShieldCheck size={14}/>Ваше время — в надёжных руках</p><div><span>© {new Date().getFullYear()} {salon.name}</span><Link href="/admin">Для администратора <ArrowUpRight size={12}/></Link></div><small>Демонстрационный салон. Записи сохраняются; платежи проверяются только в тестовом режиме, без списания денег.</small></footer>;
}
export function AboutContent() {
  const { salon } = useBooking();
  return <><div className="page-heading"><div className="eyebrow">ПРИЯТНО ПОЗНАКОМИТЬСЯ</div><h2>Ваше место. Ваш стиль.</h2><p>Хорошая стрижка начинается с того, что вас услышали.</p></div><section className="content-card about-intro"><Scissors className="intro-icon" size={25}/><h3>Немного времени для себя</h3><p>В {salon.name} мы любим естественные образы, внимание к деталям и неспешные разговоры. Здесь можно обновить привычный стиль или попробовать что-то новое.</p><span className="soft-note">Название, описание и контакты — демонстрационные.</span></section><section className="content-card contact-card"><h3>Будем рады видеть вас</h3><div><MapPin size={19}/><span><b>Адрес</b>{salon.address}</span></div><div><Clock3 size={19}/><span><b>Расписание</b>Выберите мастера, чтобы увидеть свободные даты и время.<small>Часовой пояс: {salon.timezone}</small></span></div><div><Phone size={19}/><span><b>Телефон · демо</b>{salon.phone}</span></div>{salon.email&&<div><Mail size={19}/><span><b>Email</b><a href={`mailto:${salon.email}`}>{salon.email}</a></span></div>}</section><Link className="primary-button full-width" href="/">Посмотреть услуги <ArrowUpRight size={17}/></Link></>;
}

