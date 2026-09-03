import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { profiles } from "./profiles";

export const companies = pgTable("companies", {
  companyId: text("company_id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const companyAliases = pgTable(
  "company_aliases",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.companyId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.companyId, table.normalizedName, table.source],
    }),
  ],
);

export const companyIdentities = pgTable(
  "company_identities",
  {
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.companyId, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.value] }),
    check(
      "company_identities_kind_supported",
      sql`${table.kind} in ('domain', 'linkedin')`,
    ),
  ],
);

export const employments = pgTable(
  "employments",
  {
    employmentId: text("employment_id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId, { onDelete: "cascade" }),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.companyId),
    title: text("title"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    current: boolean("current").notNull(),
    source: text("source").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    confidence: real("confidence").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    staleAt: timestamp("stale_at", { withTimezone: true }),
  },
  (table) => [
    unique("employments_profile_source_record_unique").on(
      table.profileId,
      table.source,
      table.sourceRecordId,
    ),
    check(
      "employments_confidence_range",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
  ],
);
