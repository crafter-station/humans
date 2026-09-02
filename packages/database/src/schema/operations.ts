import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
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
  },
  (table) => [
    index("enrichment_runs_profile_started_idx").on(
      table.profileId,
      table.startedAt,
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
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("operator_audit_events_created_idx").on(table.createdAt)],
);
