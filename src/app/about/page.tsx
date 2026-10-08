import type { Metadata } from "next";
import { AboutContent } from "@/components/site-shell";
export const metadata: Metadata = { title: "О салоне" };
export default function AboutPage() { return <AboutContent/>; }
