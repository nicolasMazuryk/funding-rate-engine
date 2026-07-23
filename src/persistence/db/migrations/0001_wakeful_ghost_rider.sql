CREATE TYPE "public"."error_code" AS ENUM('kill_switch', 'limit_expired', 'ladder_no_fills', 'risk_max_concurrent_intents', 'risk_max_notional_usd', 'risk_breaker_open', 'insufficient_balance', 'account_setup_incomplete', 'pre_funding_order_failed', 'pre_funding_order_rejected', 'pre_funding_not_filled', 'funding_event_timeout', 'main_order_failed', 'main_order_rejected', 'close_pre_funding_failed');--> statement-breakpoint
CREATE TYPE "public"."exit_reason" AS ENUM('timed', 'funding_fee_event', 'funding_fee_timeout', 'tp_hit', 'sl_hit', 'deadline', 'kill_switch_flatten');--> statement-breakpoint
CREATE TABLE "fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"client_order_id" text NOT NULL,
	"px" double precision NOT NULL,
	"qty" double precision NOT NULL,
	"ts" bigint NOT NULL,
	"fee_class" text
);
--> statement-breakpoint
CREATE TABLE "funding_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"symbol" text NOT NULL,
	"funding_time" bigint NOT NULL,
	"amount" double precision NOT NULL,
	"rate" double precision
);
--> statement-breakpoint
CREATE TABLE "kill_switch" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"updated_ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"client_order_id" text NOT NULL,
	"venue_order_id" text,
	"symbol" text,
	"side" text,
	"type" text,
	"price" double precision,
	"qty" double precision,
	"status" text NOT NULL,
	"reduce_only" boolean,
	"filled_qty" double precision
);
--> statement-breakpoint
CREATE TABLE "pnl" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"intent_id" text NOT NULL,
	"p_entry" double precision,
	"p_exit" double precision,
	"p_avg" double precision,
	"delta_pnl" double precision,
	"funding_pnl" double precision,
	"fee_cost" double precision,
	"net_pnl" double precision,
	"exit_reason" "exit_reason",
	"error_code" "error_code",
	"hold_duration_s" bigint,
	"fill_count" bigint,
	"funding_received" boolean,
	"t_drop_offset_s" bigint
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"qty" double precision NOT NULL,
	"entry_price" double precision,
	"updated_ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"intent_id" text,
	"symbol" text NOT NULL,
	"engine_qty" double precision NOT NULL,
	"venue_qty" double precision NOT NULL,
	"match" boolean NOT NULL,
	"resolution" text,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"intent_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"updated_ts" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intents" ALTER COLUMN "exit_reason" SET DATA TYPE "public"."exit_reason" USING "exit_reason"::"public"."exit_reason";--> statement-breakpoint
ALTER TABLE "intents" ALTER COLUMN "error_code" SET DATA TYPE "public"."error_code" USING "error_code"::"public"."error_code";--> statement-breakpoint
CREATE UNIQUE INDEX "fills_natural_key" ON "fills" USING btree ("exchange","strategy","subaccount","client_order_id","ts","qty");--> statement-breakpoint
CREATE INDEX "fills_instance_idx" ON "fills" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_events_natural_key" ON "funding_events" USING btree ("exchange","strategy","subaccount","symbol","funding_time");--> statement-breakpoint
CREATE INDEX "funding_events_instance_idx" ON "funding_events" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE UNIQUE INDEX "kill_switch_natural_key" ON "kill_switch" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE INDEX "kill_switch_instance_idx" ON "kill_switch" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_natural_key" ON "orders" USING btree ("exchange","strategy","subaccount","client_order_id");--> statement-breakpoint
CREATE INDEX "orders_instance_idx" ON "orders" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE UNIQUE INDEX "pnl_natural_key" ON "pnl" USING btree ("exchange","strategy","subaccount","intent_id");--> statement-breakpoint
CREATE INDEX "pnl_instance_idx" ON "pnl" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_natural_key" ON "positions" USING btree ("exchange","strategy","subaccount","symbol");--> statement-breakpoint
CREATE INDEX "positions_instance_idx" ON "positions" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE INDEX "reconciliation_instance_idx" ON "reconciliation" USING btree ("exchange","strategy","subaccount");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_snapshots_natural_key" ON "tracker_snapshots" USING btree ("exchange","strategy","subaccount","intent_id");--> statement-breakpoint
CREATE INDEX "tracker_snapshots_instance_idx" ON "tracker_snapshots" USING btree ("exchange","strategy","subaccount");