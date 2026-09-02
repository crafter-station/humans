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
  integer,
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

export const contactDetails = pgTable(
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

export const contactReveals = pgTable(
  "contact_reveals",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId, { onDelete: "cascade" }),
    contactDetailId: text("contact_detail_id")
      .notNull()
      .references(() => contactDetails.id, { onDelete: "cascade" }),
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

export const profileClaims = pgTable(
  "profile_claims",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    memberId: text("member_id")
      .notNull()
      .references(() => members.clerkId),
    githubAccountId: text("github_account_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    unique("profile_claims_profile_unique").on(table.profileId),
    unique("profile_claims_member_unique").on(table.memberId),
  ],
);

export const profileRequests = pgTable("profile_requests", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.profileId),
  kind: text("kind").notNull(),
  requesterEmail: text("requester_email").notNull(),
  details: text("details").notNull(),
  previousSearchable: boolean("previous_searchable").notNull().default(false),
  previousSearchabilityReason: text("previous_searchability_reason")
    .notNull()
    .default("approved_import"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

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

export const savedLists = pgTable("saved_lists", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.clerkId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => members.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const savedListEntries = pgTable(
  "saved_list_entries",
  {
    listId: text("list_id")
      .notNull()
      .references(() => savedLists.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
    addedBy: text("added_by")
      .notNull()
      .references(() => members.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.listId, table.profileId] })],
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
