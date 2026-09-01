CREATE TABLE "member_statements" (
	"profile_id" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_statements_profile_id_field_pk" PRIMARY KEY("profile_id","field")
);
--> statement-breakpoint
CREATE TABLE "professional_links" (
	"profile_id" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "professional_links_profile_id_url_pk" PRIMARY KEY("profile_id","url")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"member_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"current_company" text,
	"github_account_id" text NOT NULL,
	"github_login" text NOT NULL,
	"eligibility_basis" text NOT NULL,
	"adult_attested" boolean NOT NULL,
	"searchable" boolean DEFAULT false NOT NULL,
	"searchability_reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_github_account_id_unique" UNIQUE("github_account_id")
);
--> statement-breakpoint
ALTER TABLE "member_statements" ADD CONSTRAINT "member_statements_profile_id_profiles_member_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_links" ADD CONSTRAINT "professional_links_profile_id_profiles_member_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_member_id_members_clerk_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;