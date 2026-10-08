import type { Catalog, ContactDetails, DemoConfirmation, DemoQuote } from "./types";
import type { DemoPaymentSession } from "./demo-payment";
import { masterCanPerform } from "./catalog-rules";

export type BookingDraft = {
  variantIds: string[]; masterId: string | null; date: string | null; time: string | null;
  contacts: ContactDetails; consent: boolean; notice: string | null;
  quote: DemoQuote | null; payment: DemoPaymentSession | null;
  receipt: DemoConfirmation | null; revision: number;
};
export const emptyDraft: BookingDraft = { variantIds: [], masterId: null, date: null, time: null,
  contacts: { name: "", phone: "", email: "", comment: "" }, consent: false,
  notice: null, quote: null, payment: null, receipt: null, revision: 0 };
export type DraftAction =
  | { type: "services"; variantIds: string[]; catalog: Catalog }
  | { type: "refresh"; catalog: Catalog }
  | { type: "master"; masterId: string }
  | { type: "date"; date: string }
  | { type: "time"; time: string }
  | { type: "contacts"; contacts: ContactDetails; consent: boolean }
  | { type: "quote"; quote: DemoQuote; revision: number }
  | { type: "payment"; payment: DemoPaymentSession }
  | { type: "confirm"; receipt: DemoConfirmation }
  | { type: "notice" }
  | { type: "reset" };
function invalidate(state: BookingDraft): BookingDraft {
  return { ...state, quote: null, payment: null, receipt: null, revision: state.revision + 1 };
}
export function bookingDraftReducer(state: BookingDraft, action: DraftAction): BookingDraft {
  switch (action.type) {
    case "services": {
      const master = action.catalog.masters.find(item => item.id === state.masterId);
      const items = action.catalog.services.flatMap(service => service.variants.filter(variant => action.variantIds.includes(variant.id)).map(variant => ({ serviceId: service.id, variantId: variant.id })));
      const compatible = items.length === action.variantIds.length && master && masterCanPerform(master, items);
      return { ...invalidate(state), variantIds: action.variantIds, masterId: compatible ? state.masterId : null,
        date: null, time: null, notice: state.masterId && !compatible
          ? "Набор услуг изменён. Прежний мастер не подходит: мастер, дата и время сброшены."
          : state.date ? "Набор услуг изменён. Выберите дату и время заново — длительность могла измениться." : null };
    }
    case "refresh": {
      const available = new Set(action.catalog.services.flatMap(service => service.variants.map(variant => variant.id)));
      const next = bookingDraftReducer(state, { type: "services", catalog: action.catalog, variantIds: state.variantIds.filter(id => available.has(id)) });
      return { ...next, consent: false, notice: state.variantIds.length ? "Каталог обновлён. Проверьте услуги, мастера, условия записи и выберите дату и время заново." : null };
    }
    case "master":
      if (state.masterId === action.masterId) return state;
      return { ...invalidate(state), masterId: action.masterId, date: null, time: null,
        notice: state.date ? "Мастер изменён. Выберите дату и время по его расписанию." : null };
    case "date":
      if (state.date === action.date) return state;
      return { ...invalidate(state), date: action.date, time: null, notice: state.time ? "Дата изменена. Выберите время заново." : null };
    case "time":
      if (state.time === action.time) return state;
      return { ...invalidate(state), time: action.time, notice: null };
    case "contacts": return { ...invalidate(state), contacts: action.contacts, consent: action.consent };
    case "quote": return action.revision === state.revision ? { ...state, quote: action.quote, payment: null, receipt: null } : state;
    case "payment": return state.receipt ? state : { ...state, payment: action.payment };
    case "confirm":
      if (state.receipt || !state.quote || (state.quote.prepaymentMinor > 0 && state.payment?.status !== "success")) return state;
      return { ...state, receipt: action.receipt };
    case "notice": return { ...state, notice: null };
    case "reset": return { ...emptyDraft, revision: state.revision + 1 };
  }
}
