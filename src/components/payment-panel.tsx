"use client";

import { useEffect, useRef, useState } from "react";
import { CreditCard, Info, RefreshCw } from "lucide-react";
import type { AppointmentView } from "@/lib/appointment-types";
import type { PaymentStatus } from "@/lib/payment-types";
import { money } from "@/lib/format";

type TestAction = "success" | "fail" | "cancel" | "expire";
const statusLabel: Record<PaymentStatus, string> = {
  PENDING: "Ожидает результата", SUCCEEDED: "Тестовая оплата успешна", FAILED: "Ошибка тестовой оплаты",
  CANCELLED: "Тестовая оплата отменена", EXPIRED: "Сессия оплаты истекла", REFUNDED: "Возврат подтверждён", PARTIALLY_REFUNDED: "Частичный возврат подтверждён",
};

export function PaymentPanel({ view, accessToken, seconds, refresh }: {
  view: AppointmentView; accessToken: string; seconds: number | null; refresh: () => void;
}) {
  const [action, setAction] = useState<TestAction>("success");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedAtSnapshot, setCompletedAtSnapshot] = useState<string | null>(null);
  const busyRef = useRef(false);
  const key = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  const active = view.payments.find(payment => payment.mode === "TEST" && payment.status === "PENDING");
  const latest = [...view.payments].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const refreshing = completedAtSnapshot === view.serverNow;
  const disabled = busy || refreshing || seconds === 0;
  const attention = view.payments.find(payment => payment.needsAttention);

  async function send(kind: "create" | "simulate") {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError(null);
    const request = new AbortController(); controller.current = request;
    try {
      if (kind === "create" && !key.current) key.current = crypto.randomUUID();
      const url = kind === "create" ? `/api/appointments/${encodeURIComponent(view.id)}/payments` : `/api/payments/test/${encodeURIComponent(active!.id)}/simulate`;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(kind === "create" ? { idempotencyKey: key.current } : { action }), signal: request.signal });
      const data = await response.json();
      if (request.signal.aborted) return;
      if (!response.ok) {
        if (kind === "create" && response.status >= 400 && response.status < 500) key.current = null;
        throw new Error(typeof data.error === "string" ? data.error : "Не удалось обработать тестовую оплату.");
      }
      if (kind === "create") key.current = null;
      setCompletedAtSnapshot(view.serverNow); refresh();
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError)
        ? cause.message : "Ответ сервера не получен. Обновите статус и повторите: платёж не создастся дважды.");
    } finally { if (!request.signal.aborted) setBusy(false); busyRef.current = false; }
  }

  return <>
    {attention && <div className="inline-note payment-attention" role="alert"><Info size={18}/><span>
      {view.status === "CONFIRMED" ? "Тестовый платёж требует проверки салоном." : "Тестовый платёж получен, но запись не подтверждена."}
      {" "}{attention.attentionReason ?? "Свяжитесь с салоном для проверки платежа."} Возврат автоматически не выполнен. Телефон: {view.details.salonPhone}.
    </span></div>}
    {view.status === "WAITING_PAYMENT" && <section className="content-card payment-card" aria-label="Предоплата">
      <div className="payment-icon"><CreditCard size={24}/></div>
      <div className="eyebrow">{view.paymentAvailability.mode === "TEST" ? "ТЕСТОВЫЙ РЕЖИМ · БЕЗ СПИСАНИЯ ДЕНЕГ" : "ПРЕДОПЛАТА"}</div>
      <h3>{active ? "Тестовая платёжная сессия" : "Предоплата за визит"}</h3>
      <div className="payment-amount">{money(active?.amountMinor ?? view.details.prepaymentRequiredMinor, view.details.currency)}</div>
      <p>Сумма рассчитана по сохранённым условиям записи.</p>
      {view.paymentAvailability.mode === "TEST" ? <>
        <p>Проверьте один из сценариев. Карта и банковские реквизиты не нужны. Результат сохраняется сервером.</p>
        {latest && !active && <p className="payment-session-status" role="status">{statusLabel[latest.status]}. Пока бронь действует, можно начать новую попытку.</p>}
        {active ? <>
          <fieldset className="payment-outcomes" disabled={disabled}><legend>Сценарий тестовой оплаты</legend>
            {([
              ["success", "Успешная оплата"], ["fail", "Ошибка"], ["cancel", "Отмена"], ["expire", "Истечение сессии"],
            ] as const).map(([value, label]) => <label key={value} className={action === value ? "selected" : ""}>
              <input type="radio" name="test-payment-outcome" value={value} checked={action === value} onChange={() => setAction(value)}/>{label}
            </label>)}
          </fieldset>
          <button className="primary-button full-width" disabled={disabled} onClick={() => send("simulate")}>{busy ? "Проверяем событие…" : "Выполнить тестовый сценарий"}</button>
        </> : <button className="primary-button full-width" disabled={disabled || !view.paymentAvailability.canCreate} onClick={() => send("create")}>{busy ? "Создаём сессию…" : latest ? "Повторить тестовую оплату" : "Перейти к тестовой оплате"}</button>}
        <p className="payment-footnote"><Info size={14}/>Новая попытка не продлевает исходный срок брони.</p>
      </> : <p>{view.paymentAvailability.reason ?? "Платёжный адаптер не настроен. Без оплаты бронь автоматически истечёт."}</p>}
      {refreshing && <p role="status">Запрос обработан. Обновляем статус записи…</p>}
      {error && <div className="payment-result" role="alert"><p>{error}</p><button className="secondary-button" onClick={refresh}><RefreshCw size={15}/>Обновить статус</button></div>}
    </section>}
    {view.payments.length > 0 && <details className="content-card payment-history"><summary>История платежей</summary>
      {[...view.payments].reverse().map((payment, index) => <div key={payment.id}><span>Попытка {view.payments.length - index} · {payment.mode === "TEST" ? "ТЕСТ" : "Оплата"}</span><b>{money(payment.amountMinor, payment.currency)}</b><small>{statusLabel[payment.status]}</small></div>)}
    </details>}
  </>;
}
