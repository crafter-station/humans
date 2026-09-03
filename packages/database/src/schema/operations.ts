import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations } from "./identity";
import { profiles } from "./profiles";

export const importRuns = pgTable("import_runs", {
  id: text("id").primaryKey(),
  contractVersion: text("contract_version").notNull(),
  status: text("status").notNull(),
  validRows: integer("valid_rows").notNull(),
  invalidRows: integer("invalid_rows").notNull(),
  duplicateCandidates: jsonb("duplicate_candidates").notNull(),
  appliedChanges: jsonb("applied_changes").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const importRowFailures = pgTable(
  "import_row_failures",
  {
    importId: text("import_id")
      .notNull()
      .references(() => importRuns.id),
    row: integer("row").notNull(),
    errors: jsonb("errors").notNull(),
  },
  (table) => [
    unique("import_row_failures_run_row_unique").on(table.importId, table.row),
  ],
);

export const enrichmentRuns = pgTable(
  "enrichment_runs",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    provider: text("provider").notNull(),
    stage: text("stage"),
    status: text("status").notNull(),
    completedStages: jsonb("completed_stages")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: text("error"),
    retryClassification: text("retry_classification"),
    terminalClassification: text("terminal_classification"),
    attempts: integer("attempts").notNull().default(0),
    durationMs: integer("duration_ms"),
    costMetadata: jsonb("cost_metadata"),
    pipelineVersion: text("pipeline_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    observationsPersistedAt: timestamp("observations_persisted_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    index("enrichment_runs_profile_started_idx").on(
      table.profileId,
      table.startedAt,
    ),
  ],
);

export const enrichmentCheckpoints = pgTable(
  "enrichment_checkpoints",
  {
    runId: text("run_id")
      .notNull()
      .references(() => enrichmentRuns.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    value: jsonb("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stage] }),
    index("enrichment_checkpoints_expires_idx").on(table.expiresAt),
  ],
);

export const enrichmentDispatches = pgTable(
  "enrichment_dispatches",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId),
    provider: text("provider").notNull(),
    runId: text("run_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    triggerRunId: text("trigger_run_id"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    unique("enrichment_dispatches_run_unique").on(table.runId),
    unique("enrichment_dispatches_dedupe_unique").on(table.dedupeKey),
    index("enrichment_dispatches_due_idx").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    index("enrichment_dispatches_profile_provider_idx").on(
      table.profileId,
      table.provider,
      table.createdAt,
    ),
  ],
);

export const creditReconciliations = pgTable(
  "credit_reconciliations",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.clerkId),
    localCredits: integer("local_credits").notNull(),
    polarCredits: integer("polar_credits").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("credit_reconciliations_status_checked_idx").on(
      table.status,
      table.checkedAt,
    ),
    uniqueIndex("credit_reconciliations_period_unique")
      .on(table.organizationId, table.periodStart, table.periodEnd)
      .where(sql`${table.periodStart} is not null and ${table.periodEnd} is not null`),
  ],
);

export const operatorAuditEvents = pgTable(
  "operator_audit_events",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    operatorId: text("operator_id").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("operator_audit_events_created_idx").on(table.createdAt)],
);
