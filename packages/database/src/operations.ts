import { desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { applyCreditEntry } from "./credits";
import { revokeSuspension, suspendPrincipal } from "./abuse-controls";
import { suppressProviderIdentity } from "./import-profiles";
import { reviewProfileClaim, reviewProfileRequest } from "./profile-control";
import {
  creditReconciliations,
  creditAccounts,
  enrichmentRuns,
  importRowFailures,
  importRuns,
  operatorAuditEvents,
  principalSuspensions,
  profileClaims,
  profileObservations,
  profileRequests,
  securityActivity,
  suppressionRecords,
} from "./schema";
import type { DrizzleDatabase } from "./service/types";

export type OperatorActionContext = {
  operatorId: string;
  correlationId: string;
  reason?: string;
  correction?: {
    name?: string;
    currentCompany?: string | null;
    githubAccountId?: string;
    githubLogin?: string;
  };
};

export const recordEnrichmentRun = async (
  database: DrizzleDatabase,
  input: typeof enrichmentRuns.$inferInsert,
) => {
  const [run] = await database
    .insert(enrichmentRuns)
    .values(input)
    .onConflictDoUpdate({
      target: enrichmentRuns.id,
      set: {
        stage: input.stage,
        status: input.status,
        retryClassification: input.retryClassification,
        terminalClassification: input.terminalClassification,
        attempts: input.attempts,
        durationMs: input.durationMs,
        costMetadata: input.costMetadata,
        finishedAt: input.finishedAt,
      },
    })
    .returning();
  if (!run) throw new Error("enrichment_run_not_recorded");
  return run;
};

export const recordCreditReconciliation = async (
  database: DrizzleDatabase,
  input: { organizationId: string; polarCredits: number },
) => {
  const [account] = await database
    .select({ balance: creditAccounts.balance })
    .from(creditAccounts)
    .where(eq(creditAccounts.organizationId, input.organizationId))
    .limit(1);
  const localCredits = account?.balance ?? 0;
  const [reconciliation] = await database
    .insert(creditReconciliations)
    .values({
      ...input,
      localCredits,
      status: localCredits === input.polarCredits ? "matched" : "difference",
    })
    .returning();
  if (!reconciliation) throw new Error("credit_reconciliation_not_recorded");
  return reconciliation;
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
      .select()
      .from(profileClaims)
      .where(eq(profileClaims.status, "pending_review"))
      .orderBy(profileClaims.createdAt),
    database
      .select()
      .from(profileRequests)
      .where(eq(profileRequests.status, "pending"))
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
    claims,
    requests,
    suppressions,
    abuse: { signals: abuseSignals, suspensions },
    reconciliations,
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
    kind: input.amount > 0 ? "grant" : "charge",
    amount: Math.abs(input.amount),
    referenceId: `operator-adjustment:${context.correlationId}`,
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
) => {
  return database.transaction(async (tx) => {
    const [reconciliation] = await tx
      .update(creditReconciliations)
      .set({
        status: "retry_pending",
        attempts: sql`${creditReconciliations.attempts} + 1`,
        lastError: null,
      })
      .where(eq(creditReconciliations.id, reconciliationId))
      .returning();
    if (!reconciliation) return null;
    await tx.insert(operatorAuditEvents).values({
      ...context,
      action: "credit_reconciliation.retry",
      subjectType: "credit_reconciliation",
      subjectId: reconciliationId,
    });
    return reconciliation;
  });
};

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
