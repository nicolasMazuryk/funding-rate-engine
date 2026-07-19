CREATE TABLE "intent_wal" (
	"id" serial PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"ts" bigint NOT NULL,
	"intent_id" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"payload" jsonb,
	"client_order_id" text
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"symbol" text NOT NULL,
	"t_settle_ms" bigint,
	"state" text NOT NULL,
	"exit_reason" text,
	"error_code" text,
	"config_hash" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intent_wal_natural_key" ON "intent_wal" USING btree ("intent_id","from_state","to_state");--> statement-breakpoint
CREATE INDEX "intent_wal_instance_seq_idx" ON "intent_wal" USING btree ("exchange","strategy","subaccount","seq");--> statement-breakpoint
CREATE INDEX "intents_instance_idx" ON "intents" USING btree ("exchange","strategy","subaccount");