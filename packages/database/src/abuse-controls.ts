import { and, count, countDistinct, eq, gte, isNull, sql } from "drizzle-orm";

import {
  creditAccounts,
  creditLedgerEntries,
  memberFreeCreditClaims,
  organizationEntitlements,
  organizationMemberships,
  polarWebhookEvents,
  principalSuspensions,
  securityActivity,
  securityAuditEvents,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

export type RequestSource = "web" | "api" | "mcp";
export type PrincipalType = "member" | "organization" | "api_key";

export class AbuseControlError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "verification_required"
      | "paid_subscription_required"
      | "suspended",
  ) {
    super(code);
  }
}

export type SecurityPrincipal = {
  memberId: string;
  organizationId: string;
  apiKeyId?: string;
  ipHash: string;
  source: RequestSource;
};

export const activateOrganizationEntitlement = async (
  database: DrizzleDatabase,
  input: {
    memberId: string;
    organizationId: string;
    emailVerified: boolean;
    botProtectionVerified: boolean;
  },
) =>
  database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.memberId}))`,
    );
    const [membership] = await tx
      .select({ memberId: organizationMemberships.memberId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.memberId, input.memberId),
          eq(organizationMemberships.organizationId, input.organizationId),
          eq(organizationMemberships.active, true),
        ),
      )
      .limit(1);
    if (!membership) throw new AbuseControlError("forbidden");

    const [currentEntitlement] = await tx
      .select({
        status: organizationEntitlements.status,
        tier: organizationEntitlements.tier,
      })
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organizationId, input.organizationId))
      .limit(1);
    if (currentEntitlement?.status === "active")
      return {
        tier:
          currentEntitlement.tier === "pro"
            ? ("pro" as const)
            : ("free" as const),
        status: "active" as const,
      };

    if (!input.emailVerified || !input.botProtectionVerified)
      throw new AbuseControlError("verification_required");
    const [claim] = await tx
      .insert(memberFreeCreditClaims)
      .values({
        memberId: input.memberId,
        organizationId: input.organizationId,
      })
      .onConflictDoNothing()
      .returning();
    if (!claim) {
      const [existing] = await tx
        .select({ organizationId: memberFreeCreditClaims.organizationId })
        .from(memberFreeCreditClaims)
        .where(eq(memberFreeCreditClaims.memberId, input.memberId))
        .limit(1);
      if (existing?.organizationId !== input.organizationId)
        throw new AbuseControlError("paid_subscription_required");
    }
    await tx
      .insert(organizationEntitlements)
      .values({
        organizationId: input.organizationId,
        tier: "free",
        status: "active",
      })
      .onConflictDoUpdate({
        target: organizationEntitlements.organizationId,
        set: { tier: "free", status: "active", updatedAt: new Date() },
      });
    await tx
      .insert(creditAccounts)
      .values({ organizationId: input.organizationId })
      .onConflictDoNothing();
    const [grant] = await tx
      .insert(creditLedgerEntries)
      .values({
        organizationId: input.organizationId,
        idempotencyKey: `free-activation:${input.memberId}`,
        kind: "grant",
        amount: 100,
        referenceId: input.memberId,
      })
      .onConflictDoNothing()
      .returning();
    if (grant)
      await tx
        .update(creditAccounts)
        .set({
          balance: sql`${creditAccounts.balance} + 100`,
          updatedAt: new Date(),
        })
        .where(eq(creditAccounts.organizationId, input.organizationId));
    return { tier: "free" as const, status: "active" as const };
  });

export const setPolarSubscriptionStatus = async (
  database: DrizzleDatabase,
  input: {
    organizationId: string;
    polarSubscriptionId: string;
    active: boolean;
    eventId: string;
    occurredAt: Date;
  },
) => {
  await database.transaction(async (tx) => {
    const [event] = await tx
      .insert(polarWebhookEvents)
      .values({ id: input.eventId })
      .onConflictDoNothing()
      .returning();
    if (!event) return;
    await tx
      .insert(organizationEntitlements)
      .values({
        organizationId: input.organizationId,
        tier: "pro",
        status: input.active ? "active" : "inactive",
        polarSubscriptionId: input.polarSubscriptionId,
        polarEventAt: input.occurredAt,
      })
      .onConflictDoUpdate({
        target: organizationEntitlements.organizationId,
        set: {
          tier: "pro",
          status: input.active ? "active" : "inactive",
          polarSubscriptionId: input.polarSubscriptionId,
          polarEventAt: input.occurredAt,
          updatedAt: new Date(),
        },
        setWhere: sql`${organizationEntitlements.polarEventAt} is null or ${organizationEntitlements.polarEventAt} <= ${input.occurredAt}`,
      });
  });
};

export const organizationRevealLimit = async (
  database: DrizzleDatabase | Transaction,
  organizationId: string,
) => {
  const [entitlement] = await database
    .select({
      status: organizationEntitlements.status,
      tier: organizationEntitlements.tier,
    })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1);
  return entitlement?.status === "active" && entitlement.tier === "pro"
    ? 100
    : 10;
};

export const recordSecurityAudit = async (
  database: DrizzleDatabase,
  input: {
    eventType: "contact_reveal" | "attempted_export";
    actorMemberId: string;
    organizationId: string;
    apiKeyId?: string;
    profileId?: string;
    source: RequestSource;
    correlationId: string;
    result: string;
  },
) => {
  const [event] = await database
    .insert(securityAuditEvents)
    .values(input)
    .returning();
  if (!event) throw new Error("security_audit_insert_failed");
  return event;
};

export const suspendPrincipal = async (
  database: DrizzleDatabase | Transaction,
  input: {
    principalType: PrincipalType;
    principalId: string;
    reason: string;
    automatic?: boolean;
    suspendedBy?: string;
  },
) => {
  const [suspension] = await database
    .insert(principalSuspensions)
    .values(input)
    .onConflictDoNothing()
    .returning();
  return suspension ?? null;
};

export const revokeSuspension = async (
  database: DrizzleDatabase | Transaction,
  suspensionId: string,
) => {
  const [suspension] = await database
    .update(principalSuspensions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(principalSuspensions.id, suspensionId),
        isNull(principalSuspensions.revokedAt),
      ),
    )
    .returning();
  return suspension ?? null;
};

export const assertPrincipalActive = async (
  database: DrizzleDatabase | Transaction,
  input: Pick<SecurityPrincipal, "memberId" | "organizationId" | "apiKeyId">,
) => {
  const principals = [
    { type: "member", id: input.memberId },
    { type: "organization", id: input.organizationId },
    ...(input.apiKeyId ? [{ type: "api_key", id: input.apiKeyId }] : []),
  ];
  for (const principal of principals) {
    const [suspension] = await database
      .select({ id: principalSuspensions.id })
      .from(principalSuspensions)
      .where(
        and(
          eq(principalSuspensions.principalType, principal.type),
          eq(principalSuspensions.principalId, principal.id),
          isNull(principalSuspensions.revokedAt),
        ),
      )
      .limit(1);
    if (suspension) throw new AbuseControlError("suspended");
  }
};

export const recordSecurityActivity = async (
  database: DrizzleDatabase,
  input: SecurityPrincipal & {
    kind: "organization_access" | "search" | "profile_read" | "reveal";
    fingerprint?: string;
    profileId?: string;
    now?: Date;
  },
) =>
  database.transaction(async (tx) => {
    const lockIds = [
      `member:${input.memberId}`,
      `organization:${input.organizationId}`,
      ...(input.apiKeyId ? [`api-key:${input.apiKeyId}`] : []),
    ].sort();
    for (const lockId of lockIds)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockId}))`);
    await assertPrincipalActive(tx, input);
    const now = input.now ?? new Date();
    await tx.insert(securityActivity).values({ ...input, createdAt: now });
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    if (input.apiKeyId) {
      const [sharing] = await tx
        .select({ total: countDistinct(securityActivity.ipHash) })
        .from(securityActivity)
        .where(
          and(
            eq(securityActivity.apiKeyId, input.apiKeyId),
            gte(securityActivity.createdAt, hourAgo),
          ),
        );
      if (Number(sharing?.total ?? 0) > 5)
        await suspendPrincipal(tx, {
          principalType: "api_key",
          principalId: input.apiKeyId,
          reason: "credential_sharing",
          automatic: true,
        });
    }

    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [churn] = await tx
      .select({ total: countDistinct(securityActivity.organizationId) })
      .from(securityActivity)
      .where(
        and(
          eq(securityActivity.memberId, input.memberId),
          gte(securityActivity.createdAt, dayAgo),
        ),
      );
    if (Number(churn?.total ?? 0) > 3)
      await suspendPrincipal(tx, {
        principalType: "member",
        principalId: input.memberId,
        reason: "rapid_organization_churn",
        automatic: true,
      });

    if (input.kind === "search" && input.fingerprint) {
      const [traversal] = await tx
        .select({ total: countDistinct(securityActivity.fingerprint) })
        .from(securityActivity)
        .where(
          and(
            input.apiKeyId
              ? eq(securityActivity.apiKeyId, input.apiKeyId)
              : eq(securityActivity.memberId, input.memberId),
            eq(securityActivity.kind, "search"),
            gte(securityActivity.createdAt, hourAgo),
          ),
        );
      if (Number(traversal?.total ?? 0) > 20)
        await suspendPrincipal(tx, {
          principalType: input.apiKeyId ? "api_key" : "member",
          principalId: input.apiKeyId ?? input.memberId,
          reason: "systematic_traversal",
          automatic: true,
        });
      const [organizationTraversal] = await tx
        .select({ total: countDistinct(securityActivity.fingerprint) })
        .from(securityActivity)
        .where(
          and(
            eq(securityActivity.organizationId, input.organizationId),
            eq(securityActivity.kind, "search"),
            gte(securityActivity.createdAt, hourAgo),
          ),
        );
      if (Number(organizationTraversal?.total ?? 0) > 60)
        await suspendPrincipal(tx, {
          principalType: "organization",
          principalId: input.organizationId,
          reason: "systematic_traversal",
          automatic: true,
        });
    }

    if (input.kind === "reveal" && input.profileId) {
      const [targeting] = await tx
        .select({ total: count() })
        .from(securityActivity)
        .where(
          and(
            input.apiKeyId
              ? eq(securityActivity.apiKeyId, input.apiKeyId)
              : eq(securityActivity.memberId, input.memberId),
            eq(securityActivity.kind, "reveal"),
            eq(securityActivity.profileId, input.profileId),
            gte(securityActivity.createdAt, dayAgo),
          ),
        );
      if (Number(targeting?.total ?? 0) > 5)
        await suspendPrincipal(tx, {
          principalType: input.apiKeyId ? "api_key" : "member",
          principalId: input.apiKeyId ?? input.memberId,
          reason: "repeated_targeting",
          automatic: true,
        });
    }
  });
