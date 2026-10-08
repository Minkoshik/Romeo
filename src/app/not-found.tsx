import Link from "next/link";
import { ArrowLeft } from "lucide-react";
export default function NotFound() { return <div className="empty-state"><span className="error-number">404</span><h2>Кажется, вы свернули не туда</h2><p>Этой страницы нет. Вернёмся к выбору услуг?</p><Link href="/" className="primary-button"><ArrowLeft size={16}/>К услугам</Link></div>; }
