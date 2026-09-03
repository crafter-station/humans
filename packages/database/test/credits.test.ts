import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyCreditEntry,
  applyCreditEntryInTransaction,
  finalizeCreditReservation,
  getCreditBalance,
  releaseCreditReservation,
  reserveCredit,
} from "../src/credits";
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
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_credits",
      tier: "free",
      status: "active",
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

  it("enforces the Credit reservation lifecycle through one transaction-composable interface", async () => {
    const operation = {
      organizationId: "organization_credits",
      amount: 3,
      referenceId: "contact_reveal_one",
      idempotencyKey: "contact:one",
      reservationKey: "reservation-suffix" as const,
    };
    const initialBalance = await getCreditBalance(
      database,
      "organization_credits",
    );

    await expect(
      database.transaction((tx) => reserveCredit(tx, operation)),
    ).resolves.toEqual({ applied: true });
    await expect(
      database.transaction((tx) => reserveCredit(tx, operation)),
    ).resolves.toEqual({ applied: false });
    await expect(
      database.transaction((tx) =>
        reserveCredit(tx, {
          ...operation,
          reservationKey: "idempotency-key",
        }),
      ),
    ).rejects.toThrow("idempotency_conflict");
    await expect(
      database.transaction((tx) =>
        finalizeCreditReservation(tx, {
          ...operation,
          referenceId: "different_contact_reveal",
        }),
      ),
    ).rejects.toThrow("idempotency_conflict");
    await expect(
      database.transaction((tx) => finalizeCreditReservation(tx, operation)),
    ).resolves.toEqual({ applied: true });
    await expect(
      database.transaction((tx) => releaseCreditReservation(tx, operation)),
    ).rejects.toThrow("idempotency_conflict");
    expect(await getCreditBalance(database, "organization_credits")).toBe(
      initialBalance - 3,
    );

    const releasedOperation = {
      ...operation,
      amount: 2,
      referenceId: "profile-search:fingerprint",
      idempotencyKey: "search:one",
      reservationKey: "idempotency-key" as const,
    };
    await database.transaction((tx) => reserveCredit(tx, releasedOperation));
    const releases = await Promise.all([
      database.transaction((tx) =>
        releaseCreditReservation(tx, releasedOperation),
      ),
      database.transaction((tx) =>
        releaseCreditReservation(tx, releasedOperation),
      ),
    ]);
    expect(releases.filter(({ applied }) => applied)).toHaveLength(1);
    await expect(
      database.transaction((tx) =>
        finalizeCreditReservation(tx, releasedOperation),
      ),
    ).rejects.toThrow("idempotency_conflict");
    await expect(
      database.transaction((tx) =>
        releaseCreditReservation(tx, {
          ...releasedOperation,
          idempotencyKey: "missing",
        }),
      ),
    ).rejects.toThrow("idempotency_conflict");

    const refunds = await Promise.all([
      database.transaction((tx) =>
        applyCreditEntryInTransaction(tx, {
          organizationId: operation.organizationId,
          idempotencyKey: `${operation.referenceId}:refund`,
          kind: "refund",
          amount: operation.amount,
          referenceId: operation.referenceId,
        }),
      ),
      database.transaction((tx) =>
        applyCreditEntryInTransaction(tx, {
          organizationId: operation.organizationId,
          idempotencyKey: `${operation.referenceId}:refund`,
          kind: "refund",
          amount: operation.amount,
          referenceId: operation.referenceId,
        }),
      ),
    ]);
    expect(refunds.filter(({ applied }) => applied)).toHaveLength(1);
    expect(await getCreditBalance(database, "organization_credits")).toBe(
      initialBalance,
    );
  });

  it("settles persisted reservations using both existing key conventions", async () => {
    await database.insert(schema.organizations).values({
      clerkId: "organization_legacy_credits",
      name: "Legacy Credits",
    });
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_legacy_credits",
      tier: "free",
      status: "active",
    });
    await database.insert(schema.creditAccounts).values({
      organizationId: "organization_legacy_credits",
      balance: 8,
    });
    await database.insert(schema.creditLedgerEntries).values([
      {
        organizationId: "organization_legacy_credits",
        idempotencyKey: "legacy:contact:reservation",
        kind: "reservation",
        amount: -2,
        referenceId: "legacy_contact_reveal",
      },
      {
        organizationId: "organization_legacy_credits",
        idempotencyKey: "legacy:search",
        kind: "reservation",
        amount: -1,
        referenceId: "profile-search:legacy",
      },
      {
        organizationId: "organization_legacy_credits",
        idempotencyKey: "legacy:search:release",
        kind: "release",
        amount: 1,
        referenceId: "profile-search:legacy",
      },
    ]);

    const contactOperation = {
      organizationId: "organization_legacy_credits",
      amount: 2,
      referenceId: "legacy_contact_reveal",
      idempotencyKey: "legacy:contact",
      reservationKey: "reservation-suffix" as const,
    };
    await expect(
      database.transaction((tx) =>
        finalizeCreditReservation(tx, contactOperation),
      ),
    ).resolves.toEqual({ applied: true });
    await expect(
      database.transaction((tx) =>
        finalizeCreditReservation(tx, contactOperation),
      ),
    ).resolves.toEqual({ applied: false });

    const searchOperation = {
      organizationId: "organization_legacy_credits",
      amount: 1,
      referenceId: "profile-search:legacy",
      idempotencyKey: "legacy:search",
      reservationKey: "idempotency-key" as const,
    };
    await expect(
      database.transaction((tx) =>
        releaseCreditReservation(tx, searchOperation),
      ),
    ).resolves.toEqual({ applied: false });
    await expect(
      database.transaction((tx) => reserveCredit(tx, searchOperation)),
    ).rejects.toThrow("idempotency_conflict");
    expect(
      await getCreditBalance(database, "organization_legacy_credits"),
    ).toBe(8);
  });
});
