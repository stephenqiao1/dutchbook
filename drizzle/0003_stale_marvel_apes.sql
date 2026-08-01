-- pgvector must exist before any `vector` column is created. drizzle-kit does
-- not emit this, so it is prepended by hand and must survive a regeneration.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "market_embeddings" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_proposals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"low_condition_id" text NOT NULL,
	"high_condition_id" text NOT NULL,
	"proposed_type" text NOT NULL,
	"rationale" text NOT NULL,
	"model_confidence" numeric(5, 4) NOT NULL,
	"model" text NOT NULL,
	"similarity" numeric(6, 5),
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_proposals_ordered" CHECK ("relation_proposals"."low_condition_id" < "relation_proposals"."high_condition_id")
);
--> statement-breakpoint
ALTER TABLE "market_embeddings" ADD CONSTRAINT "market_embeddings_condition_id_markets_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_proposals" ADD CONSTRAINT "relation_proposals_low_condition_id_markets_condition_id_fk" FOREIGN KEY ("low_condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_proposals" ADD CONSTRAINT "relation_proposals_high_condition_id_markets_condition_id_fk" FOREIGN KEY ("high_condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_embeddings_hnsw" ON "market_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "market_embeddings_model_idx" ON "market_embeddings" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_proposals_pair" ON "relation_proposals" USING btree ("low_condition_id","high_condition_id");--> statement-breakpoint
CREATE INDEX "relation_proposals_status_idx" ON "relation_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "relation_proposals_type_idx" ON "relation_proposals" USING btree ("proposed_type");