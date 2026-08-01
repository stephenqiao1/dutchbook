CREATE TABLE "relations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_condition_id" text NOT NULL,
	"to_condition_id" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"rationale" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relations_no_self_edge" CHECK ("relations"."from_condition_id" <> "relations"."to_condition_id")
);
--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_condition_id_markets_condition_id_fk" FOREIGN KEY ("from_condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_condition_id_markets_condition_id_fk" FOREIGN KEY ("to_condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relations_edge_key" ON "relations" USING btree ("from_condition_id","to_condition_id","type");--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("from_condition_id");--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "relations" USING btree ("to_condition_id");--> statement-breakpoint
CREATE INDEX "relations_source_idx" ON "relations" USING btree ("source");