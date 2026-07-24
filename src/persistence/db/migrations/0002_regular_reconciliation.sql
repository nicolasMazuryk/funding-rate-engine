DROP TABLE "reconciliation" CASCADE;--> statement-breakpoint
CREATE TYPE "public"."recon_dimension" AS ENUM('fills', 'position', 'funding');--> statement-breakpoint
CREATE TABLE "reconciliation" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"strategy" text NOT NULL,
	"subaccount" text NOT NULL,
	"intent_id" text,
	"symbol" text NOT NULL,
	"dimension" "public"."recon_dimension" NOT NULL,
	"engine_value" double precision NOT NULL,
	"venue_value" double precision NOT NULL,
	"resolution" text NOT NULL,
	"within_tolerance" boolean NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reconciliation_instance_idx" ON "reconciliation" USING btree ("exchange","strategy","subaccount");
