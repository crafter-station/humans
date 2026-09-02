ALTER TABLE "enrichment_runs" ADD COLUMN "terminal_classification" text;--> statement-breakpoint
ALTER TABLE "profile_observations" ADD COLUMN "stale_at" timestamp with time zone;