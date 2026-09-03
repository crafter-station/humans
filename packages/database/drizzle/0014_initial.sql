CREATE TABLE "enrichment_checkpoints" (
	"run_id" text NOT NULL,
	"stage" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_checkpoints_run_id_stage_pk" PRIMARY KEY("run_id","stage")
);
--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD COLUMN "completed_stages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD COLUMN "observations_persisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "github_inaccessible_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrichment_checkpoints" ADD CONSTRAINT "enrichment_checkpoints_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrichment_checkpoints_expires_idx" ON "enrichment_checkpoints" USING btree ("expires_at");