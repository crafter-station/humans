import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { members } from "./identity";

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
