import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { organizations } from "./identity";

export const creditAccounts = pgTable("credit_accounts", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.clerkId),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("credit_ledger_organization_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
  ],
);
