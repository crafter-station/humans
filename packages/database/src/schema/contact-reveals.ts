import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { members, organizations } from "./identity";
import { profiles } from "./profiles";

export const contactDetailSuppressions = pgTable(
  "contact_detail_suppressions",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId, { onDelete: "cascade" }),
    type: text("type").notNull(),
    suppressedBy: text("suppressed_by")
      .notNull()
      .references(() => members.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.type] })],
);

export const contactDetailInvalidations = pgTable(
  "contact_detail_invalidations",
  {
    observationId: text("observation_id").primaryKey(),
    reportedBy: text("reported_by").references(() => members.clerkId),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const contactReveals = pgTable(
  "contact_reveals",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    observationId: text("observation_id").notNull(),
    type: text("type").notNull(),
    purchasedBy: text("purchased_by")
      .notNull()
      .references(() => members.clerkId),
    price: integer("price").notNull(),
    status: text("status").notNull().default("reserved"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
  },
  (table) => [
    unique("contact_reveals_organization_observation_unique").on(
      table.organizationId,
      table.observationId,
    ),
    unique("contact_reveals_organization_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
  ],
);

export const contactRevealRequests = pgTable(
  "contact_reveal_requests",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    idempotencyKey: text("idempotency_key").notNull(),
    profileId: text("profile_id").notNull(),
    observationId: text("observation_id").notNull(),
    revealId: text("reveal_id")
      .notNull()
      .references(() => contactReveals.id),
    type: text("type").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.idempotencyKey] }),
  ],
);

export const reenrichmentOutbox = pgTable("reenrichment_outbox", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.profileId),
  observationId: text("observation_id").notNull().unique(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});
