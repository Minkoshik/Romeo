import "server-only";
import type { Catalog } from "./types";
import { getPaymentConfiguration } from "./payment-configuration";

export type DeploymentIssue = { level: "error" | "warning"; message: string };
export function assessDeployment(catalog: Catalog, ownerExists: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env, local = false, salonIsDemo = catalog.isDemo === true): DeploymentIssue[] {
  const issues: DeploymentIssue[] = [];
  const add = (level: DeploymentIssue["level"], message: string) => issues.push({ level, message });
  if (!["demo", "production"].includes(environment.APP_ENV ?? "")) add("error", "Задайте APP_ENV=demo или production.");
  if (!["DISABLED", "TEST"].includes(environment.PAYMENT_MODE ?? "")) add("error", "Задайте PAYMENT_MODE=DISABLED или TEST.");
  const production = environment.APP_ENV === "production";
  if (!ownerExists) add(local && !production ? "warning" : "error", "Первый активный владелец не создан: выполните admin:create.");
  if (production && (salonIsDemo || catalog.isDemo)) add("error", "Production использует демонстрационный салон или каталог. Подготовьте настоящие данные отдельно.");
  if (production && environment.PAYMENT_MODE === "TEST") add("error", "В production тестовая оплата запрещена; настоящего провайдера пока нет.");
  const adapter = salonIsDemo && getPaymentConfiguration(environment);
  if (environment.PAYMENT_MODE === "TEST" && !adapter) add("error", "TEST требует демонстрационный каталог и корректный серверный секрет.");
  if (!catalog.salon) add("error", "Настройки салона отсутствуют.");
  else if (catalog.salon.policy.prepaymentMode !== "DISABLED" && !adapter) add("error", "Салон требует предоплату, но доступного платёжного адаптера нет. Брони нельзя оплатить.");
  if (!catalog.services.length || !catalog.masters.length) add("error", "Для онлайн-записи нужны активные услуги и выполняющие их мастера.");
  if (salonIsDemo || catalog.isDemo) add("warning", "Демонстрационные сведения и условия; используйте только вымышленные контакты. Деньги не списываются.");
  if (!production) add("warning", "APP_ENV=demo: административная cookie не Secure. Размещайте демо только в закрытой среде.");
  return issues;
}
