CREATE TABLE "contact_detail_invalidations" (
	"observation_id" text PRIMARY KEY NOT NULL,
	"reported_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_detail_suppressions" (
	"profile_id" text NOT NULL,
	"type" text NOT NULL,
	"suppressed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_detail_suppressions_profile_id_type_pk" PRIMARY KEY("profile_id","type")
);
--> statement-breakpoint
CREATE TABLE "contact_reveal_requests" (
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"profile_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"reveal_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_reveal_requests_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "contact_reveals" RENAME TO "legacy_contact_reveals";--> statement-breakpoint
ALTER TABLE "legacy_contact_reveals" RENAME CONSTRAINT "contact_reveals_organization_id_organizations_clerk_id_fk" TO "legacy_contact_reveals_organization_id_organizations_clerk_id_fk";--> statement-breakpoint
ALTER TABLE "legacy_contact_reveals" RENAME CONSTRAINT "contact_reveals_contact_detail_id_contact_details_id_fk" TO "legacy_contact_reveals_contact_detail_id_contact_details_id_fk";--> statement-breakpoint
CREATE TABLE "contact_reveals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"type" text NOT NULL,
	"purchased_by" text NOT NULL,
	"price" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "contact_reveals_organization_observation_unique" UNIQUE("organization_id","observation_id"),
	CONSTRAINT "contact_reveals_organization_idempotency_unique" UNIQUE("organization_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "reenrichment_outbox" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"profile_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "reenrichment_outbox_observation_id_unique" UNIQUE("observation_id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "member_contact_reveals_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_detail_invalidations" ADD CONSTRAINT "contact_detail_invalidations_reported_by_members_clerk_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_detail_suppressions" ADD CONSTRAINT "contact_detail_suppressions_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_detail_suppressions" ADD CONSTRAINT "contact_detail_suppressions_suppressed_by_members_clerk_id_fk" FOREIGN KEY ("suppressed_by") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveal_requests" ADD CONSTRAINT "contact_reveal_requests_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveal_requests" ADD CONSTRAINT "contact_reveal_requests_reveal_id_contact_reveals_id_fk" FOREIGN KEY ("reveal_id") REFERENCES "public"."contact_reveals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reenrichment_outbox" ADD CONSTRAINT "reenrichment_outbox_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_purchased_by_members_clerk_id_fk" FOREIGN KEY ("purchased_by") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
