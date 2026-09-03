import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { members } from "./identity";

export const profiles = pgTable(
  "profiles",
  {
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
    githubInaccessibleSince: timestamp("github_inaccessible_since", {
      withTimezone: true,
    }),
    eligibilityBasis: text("eligibility_basis").notNull(),
    adultAttested: boolean("adult_attested").notNull(),
    searchable: boolean("searchable").notNull().default(false),
    searchabilityReason: text("searchability_reason").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "profiles_github_account_id_canonical",
      sql`case when ${table.githubAccountId} ~ '^[1-9][0-9]*$' then ${table.githubAccountId}::numeric <= 9007199254740991 else false end or (${table.searchable} = false and ${table.searchabilityReason} = 'operator_suppression')`,
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
    check(
      "suppression_records_github_id_canonical",
      sql`${table.canonicalProvider} <> 'github' or case when ${table.canonicalProviderId} ~ '^[1-9][0-9]*$' then ${table.canonicalProviderId}::numeric <= 9007199254740991 else false end`,
    ),
  ],
);

export const profileClaims = pgTable(
  "profile_claims",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    memberId: text("member_id")
      .notNull()
      .references(() => members.clerkId),
    githubAccountId: text("github_account_id").notNull(),
    githubLogin: text("github_login"),
    status: text("status").notNull(),
    evidenceReference: text("evidence_reference"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("profile_claims_active_profile_unique")
      .on(table.profileId)
      .where(sql`${table.status} in ('pending_review', 'verified')`),
    uniqueIndex("profile_claims_active_member_unique")
      .on(table.memberId)
      .where(sql`${table.status} in ('pending_review', 'verified')`),
  ],
);

export const profileRequests = pgTable(
  "profile_requests",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
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
    status: text("status").notNull().default("awaiting_verification"),
    verificationMethod: text("verification_method"),
    verificationEvidenceReference: text("verification_evidence_reference"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("profile_requests_active_profile_unique")
      .on(table.profileId)
      .where(sql`${table.status} = 'pending'`),
    check(
      "profile_requests_pending_verification_evidence",
      sql`${table.status} <> 'pending' or (${table.verificationMethod} is not null and btrim(${table.verificationMethod}) <> '' and ${table.verificationEvidenceReference} is not null and btrim(${table.verificationEvidenceReference}) <> '' and ${table.verifiedAt} is not null)`,
    ),
  ],
);

export const professionalLinks = pgTable(
  "professional_links",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    url: text("url").notNull(),
    source: text("source").notNull().default("legacy"),
    sourceRecordId: text("source_record_id"),
    verifiedProvider: text("verified_provider"),
    verifiedProviderUserId: text("verified_provider_user_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.url] }),
    check(
      "professional_links_verification_complete",
      sql`(${table.verifiedProvider} is null and ${table.verifiedProviderUserId} is null and ${table.verifiedAt} is null) or (${table.verifiedProvider} is not null and ${table.verifiedProvider} in ('github', 'linkedin') and ${table.verifiedProviderUserId} is not null and btrim(${table.verifiedProviderUserId}) <> '' and ${table.verifiedAt} is not null)`,
    ),
  ],
);
