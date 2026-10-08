"use client";
import { useEffect, useState } from "react";
import { useBooking } from "./booking-provider";
import type { DatabaseAvailability } from "@/lib/availability-types";

type State = { key: string; data: DatabaseAvailability | null; loading: boolean; error: string | null; catalogChanged: boolean };

export function useAvailability(date?: string) {
  const { master, selected, totalPrice, totalMinutes, totalBuffer, salon } = useBooking();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ key: "", data: null, loading: true, error: null, catalogChanged: false });
  const query = new URLSearchParams();
  if (master) query.set("masterId", master.id);
  selected.forEach(item => query.append("variantId", item.variant.id));
  if (date) query.set("date", date);
  const url = `/api/availability?${query}`;
  const expected = JSON.stringify({ totalPrice, totalMinutes, totalBuffer, timezone: salon.timezone });
  const key = `${url}|${expected}`;
  const enabled = Boolean(master && selected.length);
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | null = null;
    let mounted = true;
    const amounts = JSON.parse(expected) as { totalPrice: number; totalMinutes: number; totalBuffer: number; timezone: string };
    async function load() {
      controller?.abort();
      const current = new AbortController(); controller = current;
      setState(previous => ({ ...previous, key, loading: true, error: null, catalogChanged: false, data: previous.key === key ? previous.data : null }));
      try {
        const response = await fetch(url, { signal: current.signal, cache: "no-store" });
        const data = await response.json();
        if (current.signal.aborted || !mounted) return;
        if (!response.ok) {
          setState({ key, data: null, loading: false, error: data.error ?? "Не удалось загрузить расписание. Повторите попытку.", catalogChanged: response.status === 400 }); return;
        }
        if (data.source !== "database" || !Array.isArray(data.days) || !Array.isArray(data.slots)) throw new Error();
        if (data.totalPriceMinor !== amounts.totalPrice || data.totalDurationMinutes !== amounts.totalMinutes || data.totalBufferMinutes !== amounts.totalBuffer || data.timezone !== amounts.timezone) {
          setState({ key, data: null, loading: false, error: "Условия услуг изменились. Обновите каталог и проверьте выбор заново.", catalogChanged: true }); return;
        }
        setState({ key, data: data as DatabaseAvailability, loading: false, error: null, catalogChanged: false });
      } catch {
        if (!current.signal.aborted && mounted) setState({ key, data: null, loading: false, error: "Не удалось загрузить расписание. Проверьте соединение и попробуйте снова.", catalogChanged: false });
      }
    }
    const initial = window.setTimeout(load, 0);
    const interval = window.setInterval(load, 30_000);
    return () => { mounted = false; controller?.abort(); window.clearTimeout(initial); window.clearInterval(interval); };
  }, [url, key, enabled, expected, attempt]);
  const current = state.key === key;
  return { data: current ? state.data : null, loading: enabled && (!current || state.loading), error: current ? state.error : null,
    catalogChanged: current && state.catalogChanged, refresh: () => { setState(previous => ({ ...previous, loading: true, error: null })); setAttempt(value => value + 1); } };
}
