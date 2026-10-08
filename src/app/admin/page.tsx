import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getAdminSession, AdminError } from "@/lib/admin-auth";
import { AdminApp } from "@/components/admin-app";

export default async function AdminPage() {
  try {
    const token = (await cookies()).get("romeo_admin_session")?.value ?? null;
    const admin = await getAdminSession(token);
    return <AdminApp admin={admin}/>;
  } catch (error) {
    if (error instanceof AdminError && error.status === 401) redirect("/admin/login");
    return <div className="content-card admin-login" role="alert"><h1>Рабочее пространство недоступно</h1><p>Не удалось проверить доступ. Проверьте подключение к базе и обновите страницу.</p><Link className="secondary-button" href="/admin">Повторить</Link></div>;
  }
}
