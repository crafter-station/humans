CREATE TABLE "clerk_projection_versions" (
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"active" boolean NOT NULL,
	"source_updated_at" bigint NOT NULL,
	CONSTRAINT "clerk_projection_versions_entity_type_entity_id_pk" PRIMARY KEY("entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "clerk_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"clerk_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"name" text,
	"image_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"clerk_id" text NOT NULL,
	"member_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_member_id_organization_id_pk" PRIMARY KEY("member_id","organization_id"),
	CONSTRAINT "organization_memberships_clerk_id_unique" UNIQUE("clerk_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"clerk_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_member_id_members_clerk_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;