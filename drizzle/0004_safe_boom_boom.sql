ALTER TABLE "price_snapshots" ADD COLUMN "spread" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "bids" jsonb;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "asks" jsonb;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "bid_depth" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "ask_depth" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "book_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "book_hash" text;