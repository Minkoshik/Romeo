import type { Metadata } from "next";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "./globals.css";
import { BookingProvider } from "@/components/booking-provider";
import { SiteFooter, SiteFrame, SiteHeader, SkipLink } from "@/components/site-shell";
import { getPublicSalon } from "@/lib/public-salon";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const salon = await getPublicSalon();
  return { title: { default: `${salon.name} — время для себя`, template: `%s · ${salon.name}` }, description: `Демонстрационная основа онлайн-записи в салон красоты ${salon.name}. Услуги, мастера и забота о вашем стиле.`, robots: { index: false, follow: false } };
}
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const salon = await getPublicSalon();
  return <html lang="ru" data-scroll-behavior="smooth"><body><BookingProvider salon={salon}><SkipLink/><SiteFrame><SiteHeader/><main id="main" tabIndex={-1}>{children}</main><SiteFooter/></SiteFrame></BookingProvider></body></html>;
}
