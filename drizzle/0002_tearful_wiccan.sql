CREATE TABLE "relation_group_members" (
	"group_id" bigserial NOT NULL,
	"condition_id" text NOT NULL,
	CONSTRAINT "relation_group_members_group_id_condition_id_pk" PRIMARY KEY("group_id","condition_id")
);
--> statement-breakpoint
CREATE TABLE "relation_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"rationale" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relation_group_members" ADD CONSTRAINT "relation_group_members_group_id_relation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."relation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_group_members" ADD CONSTRAINT "relation_group_members_condition_id_markets_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."markets"("condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relation_group_members_condition_idx" ON "relation_group_members" USING btree ("condition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_groups_key" ON "relation_groups" USING btree ("key");--> statement-breakpoint
CREATE INDEX "relation_groups_type_idx" ON "relation_groups" USING btree ("type");