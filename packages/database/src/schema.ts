import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const members = pgTable("members", {
  clerkId: text("clerk_id").primaryKey(),
  email: text("email"),
  name: text("name"),
  imageUrl: text("image_url"),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizations = pgTable("organizations", {
  clerkId: text("clerk_id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    clerkId: text("clerk_id").notNull().unique(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.clerkId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    role: text("role").notNull(),
    active: boolean("active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.organizationId] })],
);

export const clerkWebhookEvents = pgTable("clerk_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const clerkProjectionVersions = pgTable(
  "clerk_projection_versions",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    active: boolean("active").notNull(),
    sourceUpdatedAt: bigint("source_updated_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.entityType, table.entityId] })],
);

export const profiles = pgTable("profiles", {
  profileId: text("profile_id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  memberId: text("member_id")
    .unique()
    .references(() => members.clerkId),
  name: text("name").notNull(),
  currentCompany: text("current_company"),
  githubAccountId: text("github_account_id").notNull().unique(),
  githubLogin: text("github_login").notNull(),
  eligibilityBasis: text("eligibility_basis").notNull(),
  adultAttested: boolean("adult_attested").notNull(),
  searchable: boolean("searchable").notNull().default(false),
  searchabilityReason: text("searchability_reason").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const suppressionRecords = pgTable(
  "suppression_records",
  {
    canonicalProvider: text("canonical_provider").notNull(),
    canonicalProviderId: text("canonical_provider_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.canonicalProvider, table.canonicalProviderId],
    }),
  ],
);

export const professionalLinks = pgTable(
  "professional_links",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    url: text("url").notNull(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.url] })],
);

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
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
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
  },
  (table) => [
    unique("profile_observations_source_record_field_unique").on(
      table.source,
      table.sourceRecordId,
      table.field,
    ),
  ],
);
