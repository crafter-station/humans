CREATE TABLE "profile_observations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"profile_id" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	"source_record_id" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"confidence" real NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_observations_source_record_field_unique" UNIQUE("source","source_record_id","field")
);
--> statement-breakpoint
CREATE TABLE "suppression_records" (
	"canonical_provider" text NOT NULL,
	"canonical_provider_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_records_canonical_provider_canonical_provider_id_pk" PRIMARY KEY("canonical_provider","canonical_provider_id")
);
--> statement-breakpoint
ALTER TABLE "member_statements" DROP CONSTRAINT "member_statements_profile_id_profiles_member_id_fk";
--> statement-breakpoint
ALTER TABLE "professional_links" DROP CONSTRAINT "professional_links_profile_id_profiles_member_id_fk";
--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_pkey";--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "profile_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
UPDATE "professional_links" SET "profile_id" = "profiles"."profile_id" FROM "profiles" WHERE "professional_links"."profile_id" = "profiles"."member_id";--> statement-breakpoint
UPDATE "member_statements" SET "profile_id" = "profiles"."profile_id" FROM "profiles" WHERE "member_statements"."profile_id" = "profiles"."member_id";--> statement-breakpoint
ALTER TABLE "profile_observations" ADD CONSTRAINT "profile_observations_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_statements" ADD CONSTRAINT "member_statements_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_links" ADD CONSTRAINT "professional_links_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_member_id_unique" UNIQUE("member_id");
