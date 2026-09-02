CREATE TABLE "member_free_credit_claims" (
	"member_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_entitlements" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"polar_subscription_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principal_suspensions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"reason" text NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"suspended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_activity" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"member_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text,
	"ip_hash" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text,
	"profile_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"event_type" text NOT NULL,
	"actor_member_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text,
	"profile_id" text,
	"source" text NOT NULL,
	"correlation_id" text NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_free_credit_claims" ADD CONSTRAINT "member_free_credit_claims_member_id_members_clerk_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_free_credit_claims" ADD CONSTRAINT "member_free_credit_claims_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_free_credit_claims_organization_unique" ON "member_free_credit_claims" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_entitlements_polar_subscription_unique" ON "organization_entitlements" USING btree ("polar_subscription_id") WHERE "organization_entitlements"."polar_subscription_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_suspensions_active_unique" ON "principal_suspensions" USING btree ("principal_type","principal_id") WHERE "principal_suspensions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "security_activity_member_created_idx" ON "security_activity" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "security_activity_organization_created_idx" ON "security_activity" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "security_activity_key_created_idx" ON "security_activity" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "security_audit_events_organization_created_idx" ON "security_audit_events" USING btree ("organization_id","created_at");