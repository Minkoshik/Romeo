import "dotenv/config";
import { defineConfig } from "prisma/config";

// Generation and validation are available before stage 3 configures a database.
// Commands that connect to PostgreSQL still require DATABASE_URL explicitly.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
