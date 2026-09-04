ALTER TABLE "polar_webhook_events" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "order_status" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "order_billing_reason" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "order_currency" text;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "order_total_amount" integer;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "order_refunded_amount" integer;--> statement-breakpoint
ALTER TABLE "polar_webhook_events" ADD COLUMN "order_refunded_tax_amount" integer;--> statement-breakpoint
CREATE INDEX "polar_webhook_events_order_idx" ON "polar_webhook_events" USING btree ("order_id");