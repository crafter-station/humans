import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { importProfiles, ImportContractError } from "./import-profiles";
import * as schema from "./schema";

const main = async () => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  if (
    process.env.HUMANS_ENV !== undefined &&
    process.env.HUMANS_ENV !== arguments_.environment
  ) {
    throw new Error("--environment does not match HUMANS_ENV");
  }
  if (
    arguments_.environment === "production" &&
    process.env.HUMANS_ENV !== "production"
  ) {
    throw new Error("Production imports require HUMANS_ENV=production");
  }

  const csv = await readFile(arguments_.file, "utf8");
  const pool = new Pool({ connectionString: databaseUrl });
  const database = drizzle(pool, { schema });
  try {
    const plan = await importProfiles(database, csv, { dryRun: true });
    console.log(JSON.stringify(plan, null, 2));
    if (!arguments_.apply) return;

    if (arguments_.environment === "production") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Production imports require an interactive terminal");
      }
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const confirmation = await readline.question(
        'Type "IMPORT TO PRODUCTION" to apply this plan: ',
      );
      readline.close();
      if (confirmation !== "IMPORT TO PRODUCTION") {
        throw new Error("Production import cancelled");
      }
    }

    const report = await importProfiles(database, csv, { dryRun: false });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
};

const parseArguments = (arguments_: string[]) => {
  let file: string | undefined;
  let environment: "local" | "preview" | "production" | undefined;
  let contract: string | undefined;
  let apply = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--file") file = arguments_[++index];
    else if (argument === "--environment") {
      const value = arguments_[++index];
      if (value === "local" || value === "preview" || value === "production") {
        environment = value;
      } else {
        throw new Error("--environment must be local, preview, or production");
      }
    } else if (argument === "--contract") contract = arguments_[++index];
    else if (argument === "--apply") apply = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (file === undefined) throw new Error("--file is required");
  if (environment === undefined) throw new Error("--environment is required");
  if (contract !== "humans-profiles-v1") {
    throw new Error("--contract must be humans-profiles-v1");
  }
  return { file, environment, apply };
};

main().catch((error: unknown) => {
  const message =
    error instanceof ImportContractError || error instanceof Error
      ? error.message
      : String(error);
  console.error(message);
  process.exitCode = 1;
});
