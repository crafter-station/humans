import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { members, organizations } from "./identity";

export const organizationEntitlements = pgTable(
  "organization_entitlements",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.clerkId),
    tier: text("tier").notNull(),
    status: text("status").notNull(),
    polarSubscriptionId: text("polar_subscription_id"),
    polarStatus: text("polar_status"),
    polarEventId: text("polar_event_id"),
    polarEventAt: timestamp("polar_event_at", { withTimezone: true }),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    pendingFreeAtPeriodEnd: boolean("pending_free_at_period_end")
      .notNull()
      .default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_entitlements_polar_subscription_unique")
      .on(table.polarSubscriptionId)
      .where(sql`${table.polarSubscriptionId} is not null`),
  ],
);

export const polarWebhookEvents = pgTable(
  "polar_webhook_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(
      () => organizations.clerkId,
    ),
    subscriptionId: text("subscription_id"),
    eventType: text("event_type"),
    status: text("status"),
    orderId: text("order_id"),
    orderStatus: text("order_status"),
    orderBillingReason: text("order_billing_reason"),
    orderCurrency: text("order_currency"),
    orderTotalAmount: integer("order_total_amount"),
    orderRefundedAmount: integer("order_refunded_amount"),
    orderRefundedTaxAmount: integer("order_refunded_tax_amount"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    applied: boolean("applied").notNull().default(false),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("polar_webhook_events_subscription_idx").on(table.subscriptionId),
    index("polar_webhook_events_order_idx").on(table.orderId),
  ],
);

export const memberFreeCreditClaims = pgTable(
  "member_free_credit_claims",
  {
    memberId: text("member_id")
      .primaryKey()
      .references(() => members.clerkId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("member_free_credit_claims_organization_unique").on(
      table.organizationId,
    ),
  ],
);

export const securityAuditEvents = pgTable(
  "security_audit_events",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    eventType: text("event_type").notNull(),
    actorMemberId: text("actor_member_id").notNull(),
    organizationId: text("organization_id").notNull(),
    apiKeyId: text("api_key_id"),
    profileId: text("profile_id"),
    source: text("source").notNull(),
    correlationId: text("correlation_id").notNull(),
    result: text("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("security_audit_events_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const securityActivity = pgTable(
  "security_activity",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    memberId: text("member_id").notNull(),
    organizationId: text("organization_id").notNull(),
    apiKeyId: text("api_key_id"),
    ipHash: text("ip_hash").notNull(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint"),
    profileId: text("profile_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("security_activity_member_created_idx").on(
      table.memberId,
      table.createdAt,
    ),
    index("security_activity_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("security_activity_key_created_idx").on(
      table.apiKeyId,
      table.createdAt,
    ),
  ],
);

export const principalSuspensions = pgTable(
  "principal_suspensions",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    reason: text("reason").notNull(),
    automatic: boolean("automatic").notNull().default(false),
    suspendedBy: text("suspended_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("principal_suspensions_active_unique")
      .on(table.principalType, table.principalId)
      .where(sql`${table.revokedAt} is null`),
  ],
);
