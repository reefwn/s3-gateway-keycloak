CREATE TABLE "active_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_sub" text NOT NULL,
	"type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid,
	"event_kind" text NOT NULL,
	"outcome" text,
	"error_class" text,
	"actor_sub" text NOT NULL,
	"username" text,
	"email" text,
	"action" text NOT NULL,
	"bucket" text,
	"object_key" text,
	"prefix" text,
	"correlation_id" text NOT NULL,
	"source_ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "active_transfers_actor_type_expiry_idx" ON "active_transfers" USING btree ("actor_sub","type","expires_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_id_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_sub_idx" ON "audit_events" USING btree ("actor_sub");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("bucket","object_key");
