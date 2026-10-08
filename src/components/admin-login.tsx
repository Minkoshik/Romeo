"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";

export function AdminLogin() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="admin-login content-card"><LockKeyhole size={28}/><div className="eyebrow">РОМЕО · УПРАВЛЕНИЕ САЛОНОМ</div><h1>Вход администратора</h1><p>Услуги, расписание и записи в одном рабочем пространстве.</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (pending) return;
      const form = event.currentTarget; const fields = new FormData(form);
      setPending(true); setError(null);
      try {
        const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: fields.get("email"), password: fields.get("password") }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Не удалось войти. Повторите попытку.");
        form.reset(); router.replace("/admin"); router.refresh();
      } catch (cause) { setError(cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError) ? cause.message : "Сервер недоступен. Проверьте соединение."); }
      finally { setPending(false); }
    }}>
      <label>Email<input type="email" name="email" autoComplete="username" required maxLength={254}/></label>
      <label>Пароль<input type="password" name="password" autoComplete="current-password" required maxLength={256}/></label>
      {error && <p role="alert" className="admin-error">{error}</p>}
      <button className="primary-button full-width" disabled={pending}>{pending ? "Проверяем…" : "Войти"}</button>
    </form>
    <details><summary>Первый вход</summary><p>Создайте первого администратора командой <code>npm run admin:create</code> в папке проекта. Email, имя и пароль вводятся локально; общего пароля нет.</p></details>
    <Link href="/" className="admin-back">Вернуться на сайт</Link>
  </div>;
}
