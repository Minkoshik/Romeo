import "server-only";

const DEFAULT_INTERVAL_MS = 30_000;
const FAILURE_MESSAGE = "Не удалось освободить истекшие брони. Сервер повторит проверку автоматически.";
const RECOVERY_MESSAGE = "Проверка истекших броней восстановлена.";

type TimerHandle = { unref(): unknown };
export type AppointmentExpiryScheduler = {
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
};
export type AppointmentExpiryWorkerOptions = {
  /** Injected only for tests or a separately owned database connection. */
  expire?: () => Promise<number>;
  intervalMs?: number;
  logger?: Pick<Console, "info" | "warn">;
  scheduler?: AppointmentExpiryScheduler;
  /** A standalone daemon owns its process; the embedded server timer is unref'ed. */
  keepAlive?: boolean;
};
export type AppointmentExpiryWorker = {
  tick(): Promise<void>;
  stop(): Promise<void>;
  readonly stopped: boolean;
};

const defaultScheduler: AppointmentExpiryScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

async function expireFromDatabase() {
  const { expireAppointmentHolds } = await import("./appointment-repository");
  return expireAppointmentHolds();
}

/** Starts immediately, serializes ticks, and survives a temporary database outage. */
export function createAppointmentExpiryWorker(options: AppointmentExpiryWorkerOptions = {}): AppointmentExpiryWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) throw new Error("Некорректный интервал проверки броней");
  const expire = options.expire ?? expireFromDatabase;
  const logger = options.logger ?? console;
  const scheduler = options.scheduler ?? defaultScheduler;
  let stopped = false;
  let failed = false;
  let running: Promise<void> | null = null;

  function report(level: "info" | "warn", message: string) {
    try { logger[level](message); } catch { /* A logging failure must not stop expiry or leak the operation error. */ }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    // Begin on a microtask so even a synchronously throwing operation cannot
    // race assignment of the overlap guard or leave an unhandled rejection.
    running = Promise.resolve().then(expire).then(count => {
      if (failed) report("info", RECOVERY_MESSAGE);
      failed = false;
      if (count > 0) report("info", `Истекшие брони освобождены: ${count}.`);
    }, () => {
      if (!failed) report("warn", FAILURE_MESSAGE);
      failed = true;
    }).finally(() => { running = null; });
    return running;
  }

  const timer = scheduler.setInterval(() => { void tick(); }, intervalMs);
  if (!options.keepAlive) timer.unref();
  void tick();

  return {
    tick,
    get stopped() { return stopped; },
    async stop() {
      if (!stopped) {
        stopped = true;
        scheduler.clearInterval(timer);
      }
      await running;
    },
  };
}

const workerGlobal = globalThis as typeof globalThis & { romeoAppointmentExpiryWorker?: AppointmentExpiryWorker };

/** HMR and repeated instrumentation registration share one timer per process. */
export function startAppointmentExpiryWorker(options: AppointmentExpiryWorkerOptions = {}): AppointmentExpiryWorker {
  const current = workerGlobal.romeoAppointmentExpiryWorker;
  if (current && !current.stopped) return current;
  const worker = createAppointmentExpiryWorker(options);
  workerGlobal.romeoAppointmentExpiryWorker = worker;
  return worker;
}

export async function stopAppointmentExpiryWorker(): Promise<void> {
  const current = workerGlobal.romeoAppointmentExpiryWorker;
  if (!current) return;
  await current.stop();
  if (workerGlobal.romeoAppointmentExpiryWorker === current) delete workerGlobal.romeoAppointmentExpiryWorker;
}
