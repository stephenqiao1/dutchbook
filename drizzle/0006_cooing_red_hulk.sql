CREATE TABLE "alert_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"alert_key" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'discord' NOT NULL,
	"message_id" text,
	"first_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_count" numeric(10, 0) DEFAULT '1' NOT NULL,
	"last_alert_value" numeric(18, 8),
	"escalations" numeric(10, 0) DEFAULT '0' NOT NULL,
	"resolved_notified_at" timestamp with time zone,
	"last_payload" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_key" ON "alert_deliveries" USING btree ("alert_key");--> statement-breakpoint
CREATE INDEX "alert_deliveries_kind_idx" ON "alert_deliveries" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "alert_deliveries_last_sent_idx" ON "alert_deliveries" USING btree ("last_sent_at");