CREATE TABLE "saved_list_entries" (
	"list_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_list_entries_list_id_profile_id_pk" PRIMARY KEY("list_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "saved_lists" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_list_entries" ADD CONSTRAINT "saved_list_entries_list_id_saved_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."saved_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_list_entries" ADD CONSTRAINT "saved_list_entries_profile_id_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_list_entries" ADD CONSTRAINT "saved_list_entries_added_by_members_clerk_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_lists" ADD CONSTRAINT "saved_lists_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_lists" ADD CONSTRAINT "saved_lists_created_by_members_clerk_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;