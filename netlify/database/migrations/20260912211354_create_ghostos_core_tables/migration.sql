CREATE TABLE "acquisition_channels" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"kind" text DEFAULT 'organic' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"leads_this_month" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"last_worked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" serial PRIMARY KEY,
	"agent_key" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"summary" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY,
	"agent_key" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"key" text PRIMARY KEY,
	"name" text NOT NULL,
	"department" text NOT NULL,
	"mission" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"current_task" text DEFAULT '' NOT NULL,
	"latest_result" text DEFAULT '' NOT NULL,
	"next_action" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_proposals" (
	"id" serial PRIMARY KEY,
	"title" text NOT NULL,
	"area" text DEFAULT 'general' NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"proposed_change" text DEFAULT '' NOT NULL,
	"risk" text DEFAULT 'low' NOT NULL,
	"requires_owner" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"channel" text DEFAULT 'google' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"daily_budget" numeric(10,2),
	"spend_to_date" numeric(10,2) DEFAULT '0',
	"leads" integer DEFAULT 0 NOT NULL,
	"booked_jobs" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" serial PRIMARY KEY,
	"platform" text DEFAULT 'facebook' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'direct' NOT NULL,
	"stage" text DEFAULT 'lead' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"airtable_record_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_entries" (
	"id" serial PRIMARY KEY,
	"entry_type" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"amount" numeric(10,2) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"job_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_opportunities" (
	"id" serial PRIMARY KEY,
	"title" text NOT NULL,
	"kind" text DEFAULT 'partnership' NOT NULL,
	"stage" text DEFAULT 'identified' NOT NULL,
	"potential_value" numeric(10,2),
	"contact" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" serial PRIMARY KEY,
	"agent_key" text DEFAULT 'ATLAS' NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"recommendation" text DEFAULT '' NOT NULL,
	"amount" numeric(10,2),
	"urgency" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_id" integer,
	"payload" jsonb,
	"resolution" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_parts" (
	"id" serial PRIMARY KEY,
	"part_name" text NOT NULL,
	"device_model" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"vendor_url" text DEFAULT '' NOT NULL,
	"unit_cost" numeric(10,2),
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_at" integer DEFAULT 1 NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY,
	"tracking_code" text NOT NULL UNIQUE,
	"customer_id" integer,
	"device" text DEFAULT '' NOT NULL,
	"issue" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'intake' NOT NULL,
	"public_status" text DEFAULT 'Received' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"quoted_price" numeric(10,2),
	"parts_cost" numeric(10,2),
	"amount_collected" numeric(10,2),
	"assigned_to" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"airtable_record_id" text,
	"promised_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"repair_started_at" timestamp with time zone,
	"repair_finished_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity" ("created_at");--> statement-breakpoint
CREATE INDEX "customers_stage_idx" ON "customers" ("stage");--> statement-breakpoint
CREATE INDEX "finance_type_idx" ON "finance_entries" ("entry_type");--> statement-breakpoint
CREATE INDEX "inbox_status_idx" ON "inbox_items" ("status");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" ("status");--> statement-breakpoint
ALTER TABLE "finance_entries" ADD CONSTRAINT "finance_entries_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");