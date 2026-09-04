ALTER TABLE "polar_customers" ADD COLUMN "checkout_claim_id" text;--> statement-breakpoint
ALTER TABLE "polar_customers" ADD COLUMN "checkout_claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "polar_customers" ADD COLUMN "checkout_id" text;--> statement-breakpoint
ALTER TABLE "polar_customers" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "polar_customers" ADD COLUMN "checkout_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "polar_customers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;