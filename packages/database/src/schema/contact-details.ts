import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { organizations } from "./identity";
import { profiles } from "./profiles";

export const legacyContactDetails = pgTable(
  "contact_details",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    source: text("source").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    valid: boolean("valid").notNull().default(true),
    suppressed: boolean("suppressed").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("contact_details_source_record_unique").on(
      table.source,
      table.sourceRecordId,
    ),
  ],
);

export const legacyContactReveals = pgTable(
  "legacy_contact_reveals",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId, { onDelete: "cascade" }),
    contactDetailId: text("contact_detail_id")
      .notNull()
      .references(() => legacyContactDetails.id, { onDelete: "cascade" }),
    creditCost: integer("credit_cost").notNull(),
    revealedAt: timestamp("revealed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
  },
  (table) => [
    unique("contact_reveals_organization_detail_unique").on(
      table.organizationId,
      table.contactDetailId,
    ),
  ],
);
