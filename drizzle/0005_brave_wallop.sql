CREATE TABLE "market_quotes" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"yes_price" numeric(18, 8),
	"best_bid" numeric(18, 8),
	"best_ask" numeric(18, 8),
	"quoted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'gamma-market' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "violations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"constraint_key" text NOT NULL,
	"kind" text NOT NULL,
	"relation_ids" jsonb NOT NULL,
	"group_id" text,
	"condition_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"ever_confirmed" boolean DEFAULT false NOT NULL,
	"screen_magnitude" numeric(18, 8),
	"peak_magnitude" numeric(18, 8),
	"peak_net_edge" numeric(18, 8),
	"peak_size" numeric(24, 8),
	"peak_net_profit" numeric(24, 8),
	"trade" jsonb,
	"checks" bigserial NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_quotes" ADD CONSTRAINT "market_quotes_condition_id_markets_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_quotes_fetched_at_idx" ON "market_quotes" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "violations_one_open_per_constraint" ON "violations" USING btree ("constraint_key") WHERE "violations"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "violations_status_idx" ON "violations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "violations_detected_at_idx" ON "violations" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "violations_resolved_at_idx" ON "violations" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "violations_key_idx" ON "violations" USING btree ("constraint_key");