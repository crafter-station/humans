import { createInterface } from "node:readline/promises";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

import { backfillCurrentCompanyEmployments } from "./companies";
import * as schema from "./schema";

const environment = process.argv[2];
if (!environment || !["local", "preview", "production"].includes(environment))
  throw new Error("Usage: companies:backfill <local|preview|production>");
if (process.env.HUMANS_ENV !== environment)
  throw new Error("Environment must match HUMANS_ENV");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (environment === "production") {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Production backfills require an interactive terminal");
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const confirmation = await readline.question(
    'Type "BACKFILL PRODUCTION COMPANIES" to continue: ',
  );
  readline.close();
  if (confirmation !== "BACKFILL PRODUCTION COMPANIES")
    throw new Error("Production backfill cancelled");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const created = await backfillCurrentCompanyEmployments(
    drizzle(pool, { schema }),
  );
  console.log(JSON.stringify({ created }));
} finally {
  await pool.end();
}
