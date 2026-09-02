CREATE TABLE "contact_details" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"profile_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"source_record_id" text NOT NULL,
	"valid" boolean DEFAULT true NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_details_source_record_unique" UNIQUE("source","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "contact_reveals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"contact_detail_id" text NOT NULL,
	"credit_cost" integer NOT NULL,
	"revealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "contact_reveals_organization_detail_unique" UNIQUE("organization_id","contact_detail_id")
);
--> statement-breakpoint
ALTER TABLE "contact_details" ADD CONSTRAINT "contact_details_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_contact_detail_id_contact_details_id_fk" FOREIGN KEY ("contact_detail_id") REFERENCES "public"."contact_details"("id") ON DELETE cascade ON UPDATE no action;