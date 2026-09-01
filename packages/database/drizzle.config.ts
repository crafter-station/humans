import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      // Drizzle commands run directly rather than as Turbo tasks.
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/humans",
  },
});
