CREATE TABLE "companies" (
	"company_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_aliases" (
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_aliases_company_id_normalized_name_source_pk" PRIMARY KEY("company_id","normalized_name","source")
);
--> statement-breakpoint
CREATE TABLE "company_identities" (
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"company_id" text NOT NULL,
	"source" text NOT NULL,
	"source_record_id" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_identities_kind_value_pk" PRIMARY KEY("kind","value"),
	CONSTRAINT "company_identities_kind_supported" CHECK ("company_identities"."kind" in ('domain', 'linkedin'))
);
--> statement-breakpoint
CREATE TABLE "employments" (
	"employment_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"profile_id" text NOT NULL,
	"company_id" text NOT NULL,
	"title" text,
	"started_at" text,
	"ended_at" text,
	"current" boolean NOT NULL,
	"source" text NOT NULL,
	"source_record_id" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"confidence" real NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone,
	CONSTRAINT "employments_profile_source_record_unique" UNIQUE("profile_id","source","source_record_id"),
	CONSTRAINT "employments_confidence_range" CHECK ("employments"."confidence" >= 0 and "employments"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "company_aliases" ADD CONSTRAINT "company_aliases_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_identities" ADD CONSTRAINT "company_identities_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;