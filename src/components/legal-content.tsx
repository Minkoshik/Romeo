"use client";
import Link from "next/link";
import { useBooking } from "./booking-provider";
import { CatalogState } from "./catalog-state";

export function LegalContent({ kind }: { kind: "bookingTerms" | "privacyTerms" }) {
  const { catalog, salon, loading, error } = useBooking();
  return <><div className="page-heading"><div className="eyebrow">{catalog?.isDemo ? "ДЕМОНСТРАЦИОННЫЙ ТЕКСТ" : "УСЛОВИЯ САЛОНА"}</div><h2>{kind === "bookingTerms" ? "Условия записи" : "Обработка данных"}</h2></div>
    {loading || error ? <CatalogState/> : <article className="content-card legal-copy"><p>{salon.policy[kind]}</p>{catalog?.isDemo && <p className="soft-note">Перед настоящим запуском салону нужны согласованные документы.</p>}</article>}
    <Link className="secondary-button full-width" href="/contacts">Вернуться к контактам</Link></>;
}
