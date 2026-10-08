"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Catalog, ContactDetails, DemoQuote, Master, Salon, Service, ServiceVariant } from "@/lib/types";
import { bookingDraftReducer, emptyDraft } from "@/lib/booking-draft";
import { masterCanPerform } from "@/lib/catalog-rules";
import type { AppointmentView } from "@/lib/appointment-types";

type Selected = { service: Service; variant: ServiceVariant };
type BookingContext = {
  salon: Salon; catalog: Catalog | null; loading: boolean; error: string | null;
  reload: () => void; selected: Selected[]; totalPrice: number; totalMinutes: number;
  basePrice: number; baseMinutes: number; totalBuffer: number; master: Master | null;
  toggle: (variantId: string) => void; remove: (serviceId: string) => void; clear: () => void;
  chooseMaster: (masterId: string) => void; date: string | null; time: string | null;
  setDate: (date: string) => void; setTime: (time: string) => void;
  contacts: ContactDetails; consent: boolean; setContacts: (contacts: ContactDetails, consent: boolean) => void;
  notice: string | null; dismissNotice: () => void; revision: number;
  quote: DemoQuote | null; setQuote: (quote: DemoQuote, revision: number) => void;
  appointment: { view: AppointmentView; accessToken: string } | null;
  prepareAppointment: (body: string) => { body: string; idempotencyKey: string; accessToken: string };
  saveAppointment: (view: AppointmentView, accessToken: string) => void;
  pendingAppointmentIntent: { body: string; idempotencyKey: string; accessToken: string } | null;
  clearAppointmentIntent: () => void;
};
const Context = createContext<BookingContext | null>(null);
export function BookingProvider({ salon: initialSalon, children }: { salon: Salon; children: React.ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const salon = catalog?.salon ?? initialSalon;
  const [error, setError] = useState<string | null>(null);
  const [draft, dispatch] = useReducer(bookingDraftReducer, emptyDraft);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [appointment, setAppointment] = useState<{ view: AppointmentView; accessToken: string } | null>(null);
  const appointmentIntent = useRef<{ body: string; idempotencyKey: string; accessToken: string } | null>(null);
  const [pendingAppointmentIntent, setPendingAppointmentIntent] = useState<{ body: string; idempotencyKey: string; accessToken: string } | null>(null);
  const prepareAppointment = useCallback((body: string) => {
    if (appointmentIntent.current?.body === body) return appointmentIntent.current;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const accessToken = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    appointmentIntent.current = { body, idempotencyKey: crypto.randomUUID(), accessToken };
    setPendingAppointmentIntent(appointmentIntent.current);
    return appointmentIntent.current;
  }, []);
  const saveAppointment = useCallback((view: AppointmentView, accessToken: string) => { setAppointment({ view, accessToken }); setPendingAppointmentIntent(null); }, []);
  const clearAppointmentIntent = useCallback(() => { appointmentIntent.current = null; setPendingAppointmentIntent(null); }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/catalog", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json() as Catalog;
      if (data.source !== "database" || !Array.isArray(data.services) || !Array.isArray(data.masters) || !data.salon) throw new Error();
      if (attempt > 0) dispatch({ type: "refresh", catalog: data });
      setCatalog(data); setError(null); setLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setError("Не удалось загрузить услуги. Проверьте соединение и попробуйте ещё раз."); setLoading(false);
    });
    return () => controller.abort();
  }, [attempt]);
  const master = catalog?.masters.find(item => item.id === draft.masterId) ?? null;
  const selected = useMemo(() => (catalog?.services ?? []).flatMap(service => service.variants.filter(variant => draft.variantIds.includes(variant.id)).map(variant => ({ service, variant }))), [catalog, draft.variantIds]);
  const effectiveSelected = selected.map(item => ({ ...item, variant: { ...item.variant, ...master?.overrides?.[item.variant.id] } }));
  const changeServices = useCallback((variantIds: string[]) => {
    if (catalog) dispatch({ type: "services", variantIds, catalog });
  }, [catalog]);
  const remove = useCallback((serviceId: string) => changeServices(draft.variantIds.filter(id => !catalog?.services.find(service => service.id === serviceId)?.variants.some(variant => variant.id === id))), [catalog, draft.variantIds, changeServices]);
  const toggle = useCallback((variantId: string) => {
    const service = catalog?.services.find(item => item.variants.some(variant => variant.id === variantId));
    if (!service) return;
    changeServices(draft.variantIds.includes(variantId) ? draft.variantIds.filter(id => id !== variantId) : [...draft.variantIds.filter(id => !service.variants.some(variant => variant.id === id)), variantId]);
  }, [catalog, draft.variantIds, changeServices]);
  return <Context.Provider value={{ salon, catalog, loading, error, selected: effectiveSelected, toggle, remove,
    clear: () => { dispatch({ type: "reset" }); setAppointment(null); clearAppointmentIntent(); },
    appointment, prepareAppointment, saveAppointment, pendingAppointmentIntent, clearAppointmentIntent,
    totalPrice: effectiveSelected.reduce((total, item) => total + item.variant.priceMinor, 0),
    totalMinutes: effectiveSelected.reduce((total, item) => total + item.variant.durationMinutes, 0),
    totalBuffer: salon.policy.bufferMinutes + effectiveSelected.reduce((total, item) => total + (item.variant.bufferMinutes ?? 0), 0),
    basePrice: selected.reduce((total, item) => total + item.variant.priceMinor, 0),
    baseMinutes: selected.reduce((total, item) => total + item.variant.durationMinutes, 0),
    master, chooseMaster: masterId => {
      const choice = catalog?.masters.find(item => item.id === masterId);
      if (choice && masterCanPerform(choice, selected.map(item => ({ serviceId: item.service.id, variantId: item.variant.id })))) dispatch({ type: "master", masterId });
    }, date: draft.date, time: draft.time,
    setDate: date => dispatch({ type: "date", date }), setTime: time => dispatch({ type: "time", time }),
    contacts: draft.contacts, consent: draft.consent, setContacts: (contacts, consent) => dispatch({ type: "contacts", contacts, consent }),
    notice: draft.notice, dismissNotice: () => dispatch({ type: "notice" }), revision: draft.revision,
    quote: draft.quote, setQuote: (quote, revision) => dispatch({ type: "quote", quote, revision }),
    reload: () => { setLoading(true); setError(null); setAttempt(value => value + 1); }
  }}>{children}</Context.Provider>;
}
export function useBooking() {
  const value = useContext(Context);
  if (!value) throw new Error("Контекст записи недоступен");
  return value;
}
