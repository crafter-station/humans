ALTER TABLE "profile_claims" DROP CONSTRAINT "profile_claims_profile_unique";--> statement-breakpoint
ALTER TABLE "profile_claims" DROP CONSTRAINT "profile_claims_member_unique";--> statement-breakpoint
ALTER TABLE "profile_requests" ALTER COLUMN "status" SET DEFAULT 'awaiting_verification';--> statement-breakpoint
ALTER TABLE "operator_audit_events" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "professional_links" ADD COLUMN "source" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "professional_links" ADD COLUMN "source_record_id" text;--> statement-breakpoint
ALTER TABLE "professional_links" ADD COLUMN "verified_provider" text;--> statement-breakpoint
ALTER TABLE "professional_links" ADD COLUMN "verified_provider_user_id" text;--> statement-breakpoint
ALTER TABLE "professional_links" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_claims" ADD COLUMN "github_login" text;--> statement-breakpoint
ALTER TABLE "profile_claims" ADD COLUMN "evidence_reference" text;--> statement-breakpoint
ALTER TABLE "profile_requests" ADD COLUMN "verification_method" text;--> statement-breakpoint
ALTER TABLE "profile_requests" ADD COLUMN "verification_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "profile_requests" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_claims_active_profile_unique" ON "profile_claims" USING btree ("profile_id") WHERE "profile_claims"."status" in ('pending_review', 'verified');--> statement-breakpoint
CREATE UNIQUE INDEX "profile_claims_active_member_unique" ON "profile_claims" USING btree ("member_id") WHERE "profile_claims"."status" in ('pending_review', 'verified');--> statement-breakpoint
CREATE UNIQUE INDEX "profile_requests_active_profile_unique" ON "profile_requests" USING btree ("profile_id") WHERE "profile_requests"."status" in ('awaiting_verification', 'pending');--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_github_account_id_canonical" CHECK (case when "profiles"."github_account_id" ~ '^[1-9][0-9]*$' then "profiles"."github_account_id"::numeric <= 9007199254740991 else false end or ("profiles"."searchable" = false and "profiles"."searchability_reason" = 'operator_suppression'));--> statement-breakpoint
ALTER TABLE "suppression_records" ADD CONSTRAINT "suppression_records_github_id_canonical" CHECK ("suppression_records"."canonical_provider" <> 'github' or case when "suppression_records"."canonical_provider_id" ~ '^[1-9][0-9]*$' then "suppression_records"."canonical_provider_id"::numeric <= 9007199254740991 else false end);