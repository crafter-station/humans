CREATE TABLE "polar_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "polar_event_at" timestamp with time zone;