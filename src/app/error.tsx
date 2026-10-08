"use client";
import { RefreshCw } from "lucide-react";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="empty-state" role="alert"><h2>Не удалось открыть страницу</h2><p>Попробуйте ещё раз — ваши услуги сохранятся до обновления страницы.</p><button className="secondary-button" onClick={reset}><RefreshCw size={16}/>Попробовать снова</button></div>; }
