CREATE TABLE "enrichment_dispatches" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"profile_id" text NOT NULL,
	"provider" text NOT NULL,
	"run_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"trigger_run_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "enrichment_dispatches_run_unique" UNIQUE("run_id"),
	CONSTRAINT "enrichment_dispatches_dedupe_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "enrichment_dispatches" ADD CONSTRAINT "enrichment_dispatches_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrichment_dispatches_due_idx" ON "enrichment_dispatches" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "enrichment_dispatches_profile_provider_idx" ON "enrichment_dispatches" USING btree ("profile_id","provider","created_at");