import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { revokeSuspension, suspendPrincipal } from "./abuse-controls";
import {
  type CreditMeterReader,
  listCreditUsageDeadLetters,
  reconcileCreditUsage,
  redriveCreditUsage,
} from "./billing";
import { applyCreditEntry } from "./credits";
import { EnrichmentStoreError } from "./enrichment";
import { lockGitHubIdentity } from "./github-identity";
import { suppressProviderIdentity } from "./import-profiles";
import {
  type OperatorProfileCorrection,
  reviewProfileClaim,
  reviewProfileRequest,
  verifyProfileRequest,
} from "./profile-control";
import {
  creditReconciliations,
  enrichmentRuns,
  importRowFailures,
  importRuns,
  operatorAuditEvents,
  principalSuspensions,
  profileClaims,
  profileObservations,
  profileRequests,
  profiles,
  securityActivity,
  suppressionRecords,
} from "./schema";
import type { DrizzleDatabase } from "./service/types";

export type OperatorActionContext = {
  operatorId: string;
  correlationId: string;
  reason?: string;
  evidenceReference?: string;
  correction?: OperatorProfileCorrection;
};

export const recordEnrichmentRun = async (
  database: DrizzleDatabase,
  input: typeof enrichmentRuns.$inferInsert,
) => {
  return database.transaction(async (transaction) => {
    const [identity] = await transaction
      .select({
        githubAccountId: profiles.githubAccountId,
        searchabilityReason: profiles.searchabilityReason,
      })
      .from(profiles)
      .where(eq(profiles.profileId, input.profileId))
      .limit(1);
    if (!identity) throw new EnrichmentStoreError("profile_not_found");
    if (identity.searchabilityReason === "operator_suppression")
      throw new EnrichmentStoreError("profile_suppressed");
    await lockGitHubIdentity(transaction, identity.githubAccountId);
    const [profile] = await transaction
      .select({
        searchabilityReason: profiles.searchabilityReason,
        suppressionId: suppressionRecords.canonicalProviderId,
      })
      .from(profiles)
      .leftJoin(
        suppressionRecords,
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
        ),
      )
      .where(eq(profiles.profileId, input.profileId))
      .limit(1)
      .for("update", { of: profiles });
    if (!profile) throw new EnrichmentStoreError("profile_not_found");
    if (
      profile.searchabilityReason === "operator_suppression" ||
      profile.suppressionId !== null
    )
      throw new EnrichmentStoreError("profile_suppressed");

    const [run] = await transaction
      .insert(enrichmentRuns)
      .values(input)
      .onConflictDoUpdate({
        target: enrichmentRuns.id,
        set: {
          stage: input.stage,
          status: input.status,
          completedStages: input.completedStages,
          error: input.error,
          retryClassification: input.retryClassification,
          terminalClassification: input.terminalClassification,
          attempts: input.attempts,
          durationMs: input.durationMs,
          costMetadata: input.costMetadata,
          finishedAt: input.finishedAt,
          observationsPersistedAt: input.observationsPersistedAt,
        },
        setWhere: and(
          eq(enrichmentRuns.profileId, input.profileId),
          eq(enrichmentRuns.provider, input.provider),
        ),
      })
      .returning();
    if (!run) throw new EnrichmentStoreError("run_id_collision");
    return run;
  });
};

const audit = (
  database: DrizzleDatabase,
  context: OperatorActionContext,
  action: string,
  subjectType: string,
  subjectId: string,
) => {
  const { correction: _, ...auditContext } = context;
  return database.insert(operatorAuditEvents).values({
    ...auditContext,
    action,
    subjectType,
    subjectId,
  });
};

export const recordOperatorAudit = (
  database: DrizzleDatabase,
  context: OperatorActionContext,
  action: string,
  subjectType: string,
  subjectId: string,
) =>
  audit(database, context, action, subjectType, subjectId).then(
    () => undefined,
  );

export const getOperatorOverview = async (database: DrizzleDatabase) => {
  const imports = await database
    .select()
    .from(importRuns)
    .orderBy(desc(importRuns.startedAt))
    .limit(50);
  const [
    failures,
    runs,
    claims,
    requests,
    suppressions,
    suspensions,
    abuseSignals,
    reconciliations,
    creditUsageDeadLetters,
    auditTrail,
    staleObservations,
  ] = await Promise.all([
    imports.length === 0
      ? Promise.resolve([])
      : database
          .select()
          .from(importRowFailures)
          .where(
            inArray(
              importRowFailures.importId,
              imports.map(({ id }) => id),
            ),
          ),
    database
      .select()
      .from(enrichmentRuns)
      .orderBy(desc(enrichmentRuns.startedAt))
      .limit(100),
    database
      .select({
        claim: profileClaims,
        targetGithubAccountId: profiles.githubAccountId,
        targetGithubLogin: profiles.githubLogin,
      })
      .from(profileClaims)
      .innerJoin(profiles, eq(profiles.profileId, profileClaims.profileId))
      .where(eq(profileClaims.status, "pending_review"))
      .orderBy(profileClaims.createdAt),
    database
      .select()
      .from(profileRequests)
      .where(
        inArray(profileRequests.status, ["awaiting_verification", "pending"]),
      )
      .orderBy(profileRequests.createdAt),
    database
      .select()
      .from(suppressionRecords)
      .orderBy(desc(suppressionRecords.createdAt))
      .limit(100),
    database
      .select()
      .from(principalSuspensions)
      .where(isNull(principalSuspensions.revokedAt))
      .orderBy(desc(principalSuspensions.createdAt))
      .limit(100),
    database
      .select({
        memberId: securityActivity.memberId,
        organizationId: securityActivity.organizationId,
        apiKeyId: securityActivity.apiKeyId,
        kind: securityActivity.kind,
        profileId: securityActivity.profileId,
        createdAt: securityActivity.createdAt,
      })
      .from(securityActivity)
      .orderBy(desc(securityActivity.createdAt))
      .limit(100),
    database
      .select()
      .from(creditReconciliations)
      .orderBy(desc(creditReconciliations.checkedAt))
      .limit(100),
    listCreditUsageDeadLetters(database),
    database
      .select()
      .from(operatorAuditEvents)
      .orderBy(desc(operatorAuditEvents.createdAt))
      .limit(100),
    database
      .select({
        profileId: profileObservations.profileId,
        source: profileObservations.source,
        pipelineVersion: profileObservations.pipelineVersion,
        collectedAt: profileObservations.collectedAt,
      })
      .from(profileObservations)
      .where(isNotNull(profileObservations.staleAt))
      .orderBy(profileObservations.collectedAt)
      .limit(100),
  ]);

  const failuresByImport = new Map<string, typeof failures>();
  for (const failure of failures) {
    const rows = failuresByImport.get(failure.importId) ?? [];
    rows.push(failure);
    failuresByImport.set(failure.importId, rows);
  }
  return {
    imports: imports.map((run) => ({
      ...run,
      rowFailures: failuresByImport.get(run.id) ?? [],
    })),
    enrichment: {
      runs,
      staleObservations,
      providerUsage: Object.values(
        runs.reduce<
          Record<
            string,
            {
              provider: string;
              runs: number;
              attempts: number;
              durationMs: number;
            }
          >
        >((usage, run) => {
          const current = usage[run.provider] ?? {
            provider: run.provider,
            runs: 0,
            attempts: 0,
            durationMs: 0,
          };
          current.runs += 1;
          current.attempts += run.attempts;
          current.durationMs += run.durationMs ?? 0;
          usage[run.provider] = current;
          return usage;
        }, {}),
      ),
    },
    claims: claims.map(({ claim, ...target }) => ({ ...claim, ...target })),
    requests,
    suppressions,
    abuse: { signals: abuseSignals, suspensions },
    reconciliations,
    creditUsageDeadLetters,
    auditTrail,
  };
};

export const reviewClaimAsOperator = async (
  database: DrizzleDatabase,
  claimId: string,
  approved: boolean,
  context: OperatorActionContext,
) => {
  return reviewProfileClaim(database, claimId, approved, context);
};

export const reviewRequestAsOperator = async (
  database: DrizzleDatabase,
  requestId: string,
  confirmed: boolean,
  context: OperatorActionContext,
) => {
  return reviewProfileRequest(database, requestId, confirmed, context);
};

export const verifyRequestAsOperator = async (
  database: DrizzleDatabase,
  requestId: string,
  context: OperatorActionContext & {
    evidenceReference: string;
    verificationMethod: string;
  },
) => verifyProfileRequest(database, requestId, context);

export const suppressProfileAsOperator = async (
  database: DrizzleDatabase,
  input: { canonicalProviderId: string; reason: string },
  context: OperatorActionContext,
) => {
  await suppressProviderIdentity(
    database,
    { canonicalProvider: "github", ...input },
    context,
  );
};

export const adjustCreditsAsOperator = async (
  database: DrizzleDatabase,
  input: { organizationId: string; amount: number; idempotencyKey: string },
  context: OperatorActionContext,
) => {
  const result = await applyCreditEntry(database, {
    organizationId: input.organizationId,
    idempotencyKey: `operator:${input.idempotencyKey}`,
    kind: "adjustment",
    amount: input.amount,
    referenceId: `operator-adjustment:${input.idempotencyKey}`,
    actor: { type: "operator", id: context.operatorId },
    operation: "billing.credit.adjustment",
    operatorAudit: {
      ...context,
      action: "credits.adjust",
      subjectType: "organization",
      subjectId: input.organizationId,
    },
  });
  return result;
};

export const retryReconciliationAsOperator = async (
  database: DrizzleDatabase,
  reconciliationId: string,
  context: OperatorActionContext,
  readMeter: CreditMeterReader,
) => {
  const [reconciliation] = await database
    .select({ id: creditReconciliations.id })
    .from(creditReconciliations)
    .where(eq(creditReconciliations.id, reconciliationId))
    .limit(1);
  if (!reconciliation) return null;
  await database.transaction(async (tx) => {
    await tx.insert(operatorAuditEvents).values({
      ...context,
      action: "credit_reconciliation.retry",
      subjectType: "credit_reconciliation",
      subjectId: reconciliationId,
    });
  });
  return reconcileCreditUsage(database, { reconciliationId }, readMeter);
};

export const redriveCreditUsageAsOperator = (
  database: DrizzleDatabase,
  ids: readonly string[],
  context: OperatorActionContext,
) =>
  database.transaction(async (tx) => {
    const redriven = await redriveCreditUsage(tx, { ids });
    if (redriven.length > 0)
      await tx.insert(operatorAuditEvents).values(
        redriven.map(({ id }) => ({
          ...context,
          action: "credit_usage.redrive",
          subjectType: "credit_usage_outbox",
          subjectId: id,
        })),
      );
    return redriven;
  });

export const suspendPrincipalAsOperator = (
  database: DrizzleDatabase,
  input: Parameters<typeof suspendPrincipal>[1],
  context: OperatorActionContext,
) =>
  database.transaction(async (tx) => {
    const suspension = await suspendPrincipal(tx, input);
    await tx.insert(operatorAuditEvents).values({
      ...context,
      action: "principal.suspend",
      subjectType: input.principalType,
      subjectId: input.principalId,
    });
    return suspension;
  });

export const revokeSuspensionAsOperator = (
  database: DrizzleDatabase,
  suspensionId: string,
  context: OperatorActionContext,
) =>
  database.transaction(async (tx) => {
    const suspension = await revokeSuspension(tx, suspensionId);
    if (suspension)
      await tx.insert(operatorAuditEvents).values({
        ...context,
        action: "principal.unsuspend",
        subjectType: suspension.principalType,
        subjectId: suspension.principalId,
      });
    return suspension;
  });
