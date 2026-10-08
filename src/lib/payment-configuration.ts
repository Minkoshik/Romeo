import "server-only";

type PaymentEnvironment = Readonly<Record<string, string | undefined>>;
export type TestPaymentConfiguration = {
  provider: "ROMEO_TEST";
  mode: "TEST";
  webhookSecret: string;
};
export type TestPaymentAvailability = { mode: "TEST" | "DISABLED"; reason?: string };

const DISABLED_REASON = "Тестовая оплата в этом окружении недоступна.";

export class PaymentConfigurationError extends Error {
  readonly status = 503;
  constructor() { super(DISABLED_REASON); this.name = "PaymentConfigurationError"; }
}

/** Read only on the server. This object must never be returned to the browser. */
export function getPaymentConfiguration(environment: PaymentEnvironment = process.env): TestPaymentConfiguration | null {
  // NODE_ENV=production also describes a local Next production build. Only the
  // explicit demo deployment flag can enable this internal test adapter.
  if (environment.APP_ENV !== "demo" || environment.PAYMENT_MODE !== "TEST") return null;
  const secret = environment.PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret !== secret.trim() || /[\u0000-\u001f\u007f]/.test(secret)
    || Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(secret, "utf8") > 1024
    || new Set(secret).size < 8 || /(?:change[ _-]?me|replace[ _-]?me|demo[ _-]?only|example[ _-]?secret)/i.test(secret)) return null;
  return { provider: "ROMEO_TEST", mode: "TEST", webhookSecret: secret };
}

export function assertTestPaymentEnabled(isDemo: boolean): TestPaymentConfiguration {
  const configuration = isDemo === true ? getPaymentConfiguration() : null;
  if (!configuration) throw new PaymentConfigurationError();
  return configuration;
}

/** Safe public flags only; a real salon can never enable the test adapter. */
export function testPaymentAvailability(isDemo: boolean): TestPaymentAvailability {
  return isDemo === true && getPaymentConfiguration() ? { mode: "TEST" } : { mode: "DISABLED", reason: DISABLED_REASON };
}
