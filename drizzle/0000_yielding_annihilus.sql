CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text,
	"title" text,
	"neg_risk" boolean,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "market_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"field" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"content_hash_before" text NOT NULL,
	"content_hash_after" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"event_id" text,
	"question" text,
	"slug" text,
	"description" text,
	"resolution_source" text,
	"outcomes" jsonb,
	"end_date" timestamp with time zone,
	"active" boolean,
	"closed" boolean,
	"archived" boolean,
	"clob_token_ids" jsonb,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"bid" numeric(18, 8),
	"ask" numeric(18, 8),
	"mid" numeric(18, 8),
	"source" text NOT NULL,
	CONSTRAINT "price_snapshots_condition_id_token_id_ts_pk" PRIMARY KEY("condition_id","token_id","ts")
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" jsonb NOT NULL,
	"response_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_revisions" ADD CONSTRAINT "market_revisions_condition_id_markets_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_condition_id_markets_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_slug_idx" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_last_seen_at_idx" ON "events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "market_revisions_condition_id_changed_at_idx" ON "market_revisions" USING btree ("condition_id","changed_at");--> statement-breakpoint
CREATE INDEX "market_revisions_field_idx" ON "market_revisions" USING btree ("field");--> statement-breakpoint
CREATE INDEX "market_revisions_changed_at_idx" ON "market_revisions" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "markets_event_id_idx" ON "markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "markets_last_seen_at_idx" ON "markets" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "markets_missing_since_idx" ON "markets" USING btree ("missing_since");--> statement-breakpoint
CREATE INDEX "markets_slug_idx" ON "markets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "price_snapshots_ts_idx" ON "price_snapshots" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "price_snapshots_token_ts_idx" ON "price_snapshots" USING btree ("token_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_payloads_response_hash_key" ON "raw_payloads" USING btree ("response_hash");--> statement-breakpoint
CREATE INDEX "raw_payloads_endpoint_fetched_at_idx" ON "raw_payloads" USING btree ("endpoint","fetched_at");