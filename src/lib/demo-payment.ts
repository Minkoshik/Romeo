export type DemoPaymentOutcome = "success" | "error" | "cancel" | "expired";
export type DemoPaymentStatus = "pending" | DemoPaymentOutcome;

export type DemoPaymentSession = {
  mode: "DEMO_SIMULATION";
  status: DemoPaymentStatus;
  expiresAt: number;
  attempts: number;
};

// This local simulation neither reserves an interval nor confirms a real payment.
export function createDemoPaymentSession(holdDurationMinutes: number, now = Date.now()): DemoPaymentSession {
  if (!Number.isFinite(now) || !Number.isFinite(holdDurationMinutes) || holdDurationMinutes <= 0) {
    throw new Error("Некорректное время демонстрационной оплаты");
  }
  return {
    mode: "DEMO_SIMULATION",
    status: "pending",
    expiresAt: now + holdDurationMinutes * 60_000,
    attempts: 0,
  };
}

export function expireDemoPayment(session: DemoPaymentSession, now = Date.now()): DemoPaymentSession {
  if (session.status === "success" || session.status === "expired") return session;
  return now >= session.expiresAt ? { ...session, status: "expired" } : session;
}

export function resolveDemoPayment(session: DemoPaymentSession, outcome: DemoPaymentOutcome, now = Date.now()): DemoPaymentSession {
  const current = expireDemoPayment(session, now);
  if (current.status === "success" || current.status === "expired" || current.status !== "pending") return current;
  return { ...current, status: outcome, attempts: current.attempts + 1 };
}

export function retryDemoPayment(session: DemoPaymentSession, now = Date.now()): DemoPaymentSession {
  const current = expireDemoPayment(session, now);
  return current.status === "error" || current.status === "cancel" ? { ...current, status: "pending" } : current;
}

export function demoPaymentSecondsRemaining(session: DemoPaymentSession, now = Date.now()): number {
  if (session.status === "expired") return 0;
  return Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
}
