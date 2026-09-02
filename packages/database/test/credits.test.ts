import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyCreditEntry, getCreditBalance } from "../src/credits";
import * as schema from "../src/schema";

describe("Organization credit ledger", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.pool = new Pool({
      connectionString: resources.container.getConnectionUri(),
    });
    database = drizzle(resources.pool, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    await database.insert(schema.organizations).values({
      clerkId: "organization_credits",
      name: "Credits",
    });
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("grants, charges, and refunds shared Organization credits", async () => {
    await applyCreditEntry(database, {
      organizationId: "organization_credits",
      idempotencyKey: "grant:september",
      kind: "grant",
      amount: 10,
    });
    await applyCreditEntry(database, {
      organizationId: "organization_credits",
      idempotencyKey: "reveal:one",
      kind: "charge",
      amount: 3,
      referenceId: "reveal_one",
    });
    await applyCreditEntry(database, {
      organizationId: "organization_credits",
      idempotencyKey: "refund:one",
      kind: "refund",
      amount: 3,
      referenceId: "reveal_one",
    });
    expect(await getCreditBalance(database, "organization_credits")).toBe(10);
  });

  it("is idempotent, including under concurrent delivery", async () => {
    const input = {
      organizationId: "organization_credits",
      idempotencyKey: "grant:concurrent",
      kind: "grant" as const,
      amount: 5,
    };
    const results = await Promise.all([
      applyCreditEntry(database, input),
      applyCreditEntry(database, input),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(await getCreditBalance(database, "organization_credits")).toBe(15);
    await expect(
      applyCreditEntry(database, { ...input, amount: 6 }),
    ).rejects.toThrow("idempotency_conflict");
  });

  it("rejects invalid amounts and never permits a negative balance", async () => {
    await expect(
      applyCreditEntry(database, {
        organizationId: "organization_credits",
        idempotencyKey: "invalid",
        kind: "grant",
        amount: 0,
      }),
    ).rejects.toThrow("invalid_credit_amount");
    await expect(
      applyCreditEntry(database, {
        organizationId: "organization_credits",
        idempotencyKey: "charge:too-large",
        kind: "charge",
        amount: 16,
      }),
    ).rejects.toThrow("insufficient_credits");
    expect(await getCreditBalance(database, "organization_credits")).toBe(15);
  });
});
