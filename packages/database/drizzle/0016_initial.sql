CREATE TABLE "credit_usage_outbox" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"consumption_entry_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "credit_usage_outbox_consumption_ordinal_unique" UNIQUE("consumption_entry_id","ordinal"),
	CONSTRAINT "credit_usage_outbox_idempotency_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "polar_customers" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"polar_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polar_customers_customer_unique" UNIQUE("polar_customer_id")
);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "polar_status" text;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "polar_event_id" text;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "pending_free_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD COLUMN "operation" text;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_reconciliations" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_reconciliations" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_usage_outbox" ADD CONSTRAINT "credit_usage_outbox_consumption_entry_id_credit_ledger_entries_id_fk" FOREIGN KEY ("consumption_entry_id") REFERENCES "public"."credit_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_usage_outbox" ADD CONSTRAINT "credit_usage_outbox_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polar_customers" ADD CONSTRAINT "polar_customers_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_usage_outbox_due_idx" ON "credit_usage_outbox" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "credit_usage_outbox_lease_idx" ON "credit_usage_outbox" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "credit_usage_outbox_organization_occurred_idx" ON "credit_usage_outbox" USING btree ("organization_id","occurred_at");--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD CONSTRAINT "polar_webhook_events_organization_id_organizations_clerk_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("clerk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reconciliations_period_unique" ON "credit_reconciliations" USING btree ("organization_id","period_start","period_end") WHERE "credit_reconciliations"."period_start" is not null and "credit_reconciliations"."period_end" is not null;