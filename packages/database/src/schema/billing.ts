import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { creditLedgerEntries } from "./credits";
import { organizations } from "./identity";

export const polarCustomers = pgTable(
  "polar_customers",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.clerkId),
    polarCustomerId: text("polar_customer_id").notNull(),
    checkoutClaimId: text("checkout_claim_id"),
    checkoutClaimExpiresAt: timestamp("checkout_claim_expires_at", {
      withTimezone: true,
    }),
    checkoutId: text("checkout_id"),
    checkoutUrl: text("checkout_url"),
    checkoutExpiresAt: timestamp("checkout_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("polar_customers_customer_unique").on(table.polarCustomerId),
  ],
);

export const creditUsageOutbox = pgTable(
  "credit_usage_outbox",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    consumptionEntryId: text("consumption_entry_id")
      .notNull()
      .references(() => creditLedgerEntries.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    unique("credit_usage_outbox_consumption_ordinal_unique").on(
      table.consumptionEntryId,
      table.ordinal,
    ),
    unique("credit_usage_outbox_idempotency_unique").on(table.idempotencyKey),
    index("credit_usage_outbox_due_idx").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    index("credit_usage_outbox_lease_idx").on(
      table.state,
      table.leaseExpiresAt,
    ),
    index("credit_usage_outbox_organization_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);
