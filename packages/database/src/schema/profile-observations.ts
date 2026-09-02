import {
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { profiles } from "./profiles";

export const memberStatements = pgTable("member_statements", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.profileId),
  field: text("field").notNull(),
  value: jsonb("value").notNull(),
  source: text("source").notNull(),
  pipelineVersion: text("pipeline_version").notNull(),
  confidence: real("confidence").notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const profileObservations = pgTable(
  "profile_observations",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    field: text("field").notNull(),
    value: jsonb("value").notNull(),
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
    unique("profile_observations_source_record_field_unique").on(
      table.source,
      table.sourceRecordId,
      table.field,
    ),
  ],
);
