import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadDatabaseCatalog, CatalogUnavailableError } from "@/lib/catalog-repository";

export async function GET(request: NextRequest) {
  const schema = z.object({ search: z.string().trim().max(100, "Поисковый запрос слишком длинный").default(""), category: z.string().trim().min(1).max(100).default("all") });
  const query = schema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  const headers = { "Cache-Control": "no-store" };
  if (!query.success) return NextResponse.json({ error: "Некорректные параметры каталога" }, { status: 400, headers });
  try {
    const catalog = await loadDatabaseCatalog();
    const category = catalog.categories.find(item => item.id === query.data.category || item.slug === query.data.category);
    if (query.data.category !== "all" && !category) return NextResponse.json({ error: "Указана неизвестная категория услуг" }, { status: 400, headers });
    const search = query.data.search.toLocaleLowerCase("ru");
    const services = catalog.services.filter(service => (query.data.category === "all" || service.categoryId === category?.id) && `${service.name} ${service.description}`.toLocaleLowerCase("ru").includes(search));
    return NextResponse.json({ ...catalog, services }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof CatalogUnavailableError ? error.message : "Не удалось подключиться к каталогу. Попробуйте позже." }, { status: 503, headers });
  }
}
