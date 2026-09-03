import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import { projectPolarSubscriptionEvent } from "./billing";
import {
  initializeFreeCreditPeriod,
  rolloverCreditPeriodInTransaction,
} from "./credits";
import {
  memberFreeCreditClaims,
  members,
  organizationEntitlements,
  organizationMemberships,
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
    now?: Date;
  },
) =>
  database.transaction(async (tx) => {
    for (const lockId of [
      `free-credit-member:${input.memberId}`,
      `free-credit-organization:${input.organizationId}`,
    ].sort())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockId}))`);
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

    const now = input.now ?? new Date();
    const current = await rolloverCreditPeriodInTransaction(
      tx,
      input.organizationId,
      now,
    );
    if (current?.status === "active") {
      return {
        tier: current?.tier === "pro" ? ("pro" as const) : ("free" as const),
        status: "active" as const,
      };
    }

    if (
      current?.tier === "pro" &&
      (current.periodEnd === null ||
        current.periodEnd.getTime() > now.getTime())
    )
      return { tier: "pro" as const, status: current.status };

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
      const [organizationClaim] = await tx
        .select({ memberId: memberFreeCreditClaims.memberId })
        .from(memberFreeCreditClaims)
        .where(eq(memberFreeCreditClaims.organizationId, input.organizationId))
        .limit(1);
      if (!organizationClaim) {
        if (current)
          return {
            tier: current.tier === "pro" ? ("pro" as const) : ("free" as const),
            status: current.status,
          };
        await tx
          .insert(organizationEntitlements)
          .values({
            organizationId: input.organizationId,
            tier: "free",
            status: "inactive",
          })
          .onConflictDoNothing();
        return { tier: "free" as const, status: "inactive" as const };
      }
    }
    await initializeFreeCreditPeriod(tx, {
      organizationId: input.organizationId,
      memberId: input.memberId,
      now,
    });
    return { tier: "free" as const, status: "active" as const };
  });

export const setPolarSubscriptionStatus = projectPolarSubscriptionEvent;

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

export const assertMemberActive = async (
  database: DrizzleDatabase | Transaction,
  memberId: string,
) => {
  const [member] = await database
    .select({ id: members.clerkId })
    .from(members)
    .where(
      and(
        eq(members.clerkId, memberId),
        eq(members.active, true),
        notExists(
          database
            .select({ id: principalSuspensions.id })
            .from(principalSuspensions)
            .where(
              and(
                eq(principalSuspensions.principalType, "member"),
                eq(principalSuspensions.principalId, memberId),
                isNull(principalSuspensions.revokedAt),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  if (!member) throw new AbuseControlError("forbidden");
};

export const assertPrincipalActive = async (
  database: DrizzleDatabase | Transaction,
  input: Pick<SecurityPrincipal, "memberId" | "organizationId" | "apiKeyId">,
) => {
  const [suspension] = await database
    .select({ id: principalSuspensions.id })
    .from(principalSuspensions)
    .where(
      and(
        isNull(principalSuspensions.revokedAt),
        or(
          and(
            eq(principalSuspensions.principalType, "member"),
            eq(principalSuspensions.principalId, input.memberId),
          ),
          and(
            eq(principalSuspensions.principalType, "organization"),
            eq(principalSuspensions.principalId, input.organizationId),
          ),
          input.apiKeyId
            ? and(
                eq(principalSuspensions.principalType, "api_key"),
                eq(principalSuspensions.principalId, input.apiKeyId),
              )
            : undefined,
        ),
      ),
    )
    .limit(1);
  if (suspension) throw new AbuseControlError("suspended");
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
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(lock_id))
      from jsonb_array_elements_text(${JSON.stringify(lockIds)}::jsonb) locks(lock_id)
      order by lock_id
    `);
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
