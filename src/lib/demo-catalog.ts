import type { Category, Service, Master, Catalog } from "./types";

export const demoCategories: Category[] = [
  { id: "cuts", name: "Стрижки", description: "Форма, которая подходит именно вам" },
  { id: "beard", name: "Борода", description: "Внимание к каждой детали" },
  { id: "color", name: "Окрашивание", description: "Новый оттенок, новое настроение" },
  { id: "styling", name: "Укладки", description: "Для особого случая и на каждый день" },
  { id: "care", name: "Уход", description: "Забота о здоровье ваших волос" },
  { id: "extras", name: "Дополнительно", description: "Небольшие детали большого образа" },
];
export const demoServices: Service[] = [
  { id: "mens-cut", categoryId: "cuts", name: "Мужская стрижка", description: "Консультация, мытьё, стрижка и укладка", details: "Мастер подберёт форму с учётом структуры волос и вашего привычного ритма. В завершение — укладка и рекомендации по домашнему уходу.", popular: true, variants: [{ id: "mens-cut-standard", name: "Стандартная", priceMinor: 220000, durationMinutes: 60 }] },
  { id: "womens-cut", categoryId: "cuts", name: "Женская стрижка", description: "Индивидуальная форма и лёгкая укладка", details: "Консультация, мытьё профессиональным шампунем, стрижка и укладка. Одна стоимость и длительность для любой длины волос.", variants: [{ id: "womens-cut-standard", name: "Стандартная", priceMinor: 280000, durationMinutes: 60 }] },
  { id: "kids-cut", categoryId: "cuts", name: "Детская стрижка", description: "Бережная стрижка для детей от 6 до 12 лет", details: "Спокойное знакомство с мастером, стрижка и простая укладка. Для демонстрации услуги указан возраст от 6 до 12 лет.", variants: [{ id: "kids-cut-standard", name: "Стандартная", priceMinor: 160000, durationMinutes: 45 }] },
  { id: "beard-model", categoryId: "beard", name: "Моделирование бороды", description: "Форма, чёткий контур и профессиональный уход", details: "Подбор формы, коррекция длины и окантовка. Мастер расскажет, как поддерживать результат дома.", variants: [{ id: "beard-model-standard", name: "Стандартная", priceMinor: 140000, durationMinutes: 30 }] },
  { id: "cut-beard", categoryId: "beard", name: "Стрижка и борода", description: "Полный образ за один визит", details: "Мужская стрижка и моделирование бороды у одного мастера. Мытьё волос, укладка и уход включены.", popular: true, variants: [{ id: "cut-beard-standard", name: "Комплекс", priceMinor: 320000, durationMinutes: 90 }] },
  { id: "coloring", categoryId: "color", name: "Окрашивание", description: "Ровный цвет и бережное отношение к волосам", details: "Консультация, окрашивание в один тон, мытьё и сушка. Цена зависит от выбранной длины и фиксируется до записи.", variants: [{ id: "coloring-short", name: "Короткие волосы", priceMinor: 480000, durationMinutes: 120 }, { id: "coloring-medium", name: "До плеч", priceMinor: 650000, durationMinutes: 150 }, { id: "coloring-long", name: "Ниже плеч", priceMinor: 820000, durationMinutes: 180 }] },
  { id: "toning", categoryId: "color", name: "Тонирование", description: "Обновление оттенка и естественный блеск", details: "Мягкое тонирование для освежения цвета. В услугу входят консультация, нанесение состава, мытьё и сушка.", variants: [{ id: "toning-standard", name: "Стандартное", priceMinor: 300000, durationMinutes: 60 }] },
  { id: "styling", categoryId: "styling", name: "Укладка", description: "Лёгкие волны, объём или гладкая текстура", details: "Мытьё, термозащита и укладка. Образ подбирается вместе с мастером.", variants: [{ id: "styling-standard", name: "Стандартная", priceMinor: 180000, durationMinutes: 45 }] },
  { id: "hair-care", categoryId: "care", name: "Уход за волосами", description: "Глубокое увлажнение и восстановление", details: "Диагностика состояния волос, очищение и профессиональная маска. Мастер подбирает состав по вашим потребностям.", variants: [{ id: "hair-care-standard", name: "Стандартный", priceMinor: 200000, durationMinutes: 45 }] },
  { id: "head-massage", categoryId: "extras", name: "Массаж головы", description: "Пятнадцать минут, чтобы замедлиться", details: "Расслабляющий массаж головы. Можно добавить к основной процедуре или выбрать отдельно.", variants: [{ id: "head-massage-standard", name: "Стандартный", priceMinor: 60000, durationMinutes: 15 }] },
];
export const demoMasters: Master[] = [
  { id: "alex", name: "Александр", specialty: "Барбер · мужские стрижки", description: "Любит точные формы, классические стрижки и спокойные разговоры. Поможет найти свой стиль.", initials: "А", color: "sage", serviceIds: ["mens-cut", "kids-cut", "beard-model", "cut-beard", "toning", "hair-care", "head-massage"] },
  { id: "anna", name: "Анна", specialty: "Стилист · колорист", description: "Естественные оттенки, живые текстуры и стрижки, которые легко укладывать каждый день.", initials: "А", color: "rose", serviceIds: ["mens-cut", "womens-cut", "kids-cut", "coloring", "toning", "styling", "hair-care", "head-massage"] },
  { id: "mark", name: "Марк", specialty: "Универсальный мастер", description: "От лаконичной классики до нового образа. Внимателен к деталям и вашим пожеланиям.", initials: "М", color: "sand", serviceIds: demoServices.map(service => service.id), overrides: { "mens-cut-standard": { priceMinor: 250000, durationMinutes: 75 } } },
];
export const demoCatalog: Catalog = { source: "demo", categories: demoCategories, services: demoServices, masters: demoMasters };
