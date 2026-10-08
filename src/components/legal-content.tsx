"use client";
import Link from "next/link";
import { useBooking } from "./booking-provider";
import { CatalogState } from "./catalog-state";

export function LegalContent({ kind }: { kind: "bookingTerms" | "privacyTerms" }) {
  const { catalog, salon, loading, error } = useBooking();
  return <><div className="page-heading"><div className="eyebrow">{catalog?.isDemo ? "ДЕМОНСТРАЦИОННЫЙ ТЕКСТ" : "УСЛОВИЯ САЛОНА"}</div><h2>{kind === "bookingTerms" ? "Условия записи" : "Обработка данных"}</h2></div>
    {loading || error ? <CatalogState/> : <article className="content-card legal-copy"><p>{salon.policy[kind]}</p>{kind==="bookingTerms"&&<p>Для отмены или переноса свяжитесь с салоном: {salon.phone}. {salon.policy.cancellationLeadMinutes!==undefined&&`Отмена — не позднее чем за ${salon.policy.cancellationLeadMinutes} мин до визита. `}{salon.policy.rescheduleLeadMinutes!==undefined&&`Перенос — не позднее чем за ${salon.policy.rescheduleLeadMinutes} мин до визита.`}</p>}{catalog?.isDemo && <p className="soft-note">Перед настоящим запуском салону нужны согласованные документы.</p>}</article>}
    <Link className="secondary-button full-width" href="/contacts">Вернуться к контактам</Link></>;
}
