"use client";
import { RefreshCw, SearchX, WifiOff } from "lucide-react";
import { useBooking } from "./booking-provider";
export function CatalogState() {
  const { loading, error, reload } = useBooking();
  if (loading) return <div className="loading-list" role="status" aria-label="Загрузка каталога"><span className="sr-only">Загружаем каталог…</span>{[1,2,3].map(item => <div className="skeleton" key={item}><span/><span/><span/></div>)}</div>;
  if (error) return <div className="empty-state" role="alert"><WifiOff size={28}/><h3>Не удалось загрузить каталог</h3><p>{error}</p><button className="secondary-button" onClick={reload}><RefreshCw size={16}/>Попробовать снова</button></div>;
  return null;
}
export function EmptyCatalog({ reset }: { reset: () => void }) {
  const { catalog, reload } = useBooking();
  if (catalog && !catalog.services.length) return <div className="empty-state"><SearchX size={30}/><h3>Пока нет доступных услуг</h3><p>Каталог обновляется. Попробуйте зайти позже.</p><button className="secondary-button" onClick={reload}>Обновить каталог</button></div>;
  return <div className="empty-state"><SearchX size={30}/><h3>Таких услуг пока нет</h3><p>Попробуйте другое название или выберите другую категорию.</p><button className="secondary-button" onClick={reset}>Сбросить фильтры</button></div>;
}
