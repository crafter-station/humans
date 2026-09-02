CREATE TABLE "credit_reconciliations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"local_credits" integer NOT NULL,
	"polar_credits" integer NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"provider" text NOT NULL,
	"stage" text,
	"status" text NOT NULL,
	"retry_classification" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"cost_metadata" jsonb,
	"pipeline_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_row_failures" (
	"import_id" text NOT NULL,
	"row" integer NOT NULL,
	"errors" jsonb NOT NULL,
	CONSTRAINT "import_row_failures_run_row_unique" UNIQUE("import_id","row")
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_version" text NOT NULL,
	"status" text NOT NULL,
	"valid_rows" integer NOT NULL,
	"invalid_rows" integer NOT NULL,
	"duplicate_candidates" jsonb NOT NULL,
	"applied_changes" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operator_audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"operator_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_reconciliations" ADD CONSTRAINT "credit_reconciliations_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_failures" ADD CONSTRAINT "import_row_failures_import_id_import_runs_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_reconciliations_status_checked_idx" ON "credit_reconciliations" USING btree ("status","checked_at");--> statement-breakpoint
CREATE INDEX "enrichment_runs_profile_started_idx" ON "enrichment_runs" USING btree ("profile_id","started_at");--> statement-breakpoint
CREATE INDEX "operator_audit_events_created_idx" ON "operator_audit_events" USING btree ("created_at");