CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "knowledge_consumption" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"knowledge_version" integer NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"agent_id" uuid,
	"context_snapshot_id" uuid,
	"via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"added_by" text NOT NULL,
	"commit_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"allowed_agent_ids" jsonb,
	"confidence" integer DEFAULT 50 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_agent_id" uuid,
	"source_run_id" uuid,
	"source_task_id" uuid,
	"source_actor" text NOT NULL,
	"source_commit_sha" text,
	"affected_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"superseded_by_id" uuid,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"status_reason" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"embedding" vector(256),
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("knowledge_records"."title", '')), 'A') || setweight(to_tsvector('english', coalesce("knowledge_records"."statement", '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_relations" (
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_relations_from_id_to_id_relation_pk" PRIMARY KEY("from_id","to_id","relation")
);
--> statement-breakpoint
CREATE TABLE "knowledge_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version" integer NOT NULL,
	"project_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"node_tasks" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"graph" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD COLUMN "condition" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workflow_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workflow_node_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_consumption" ADD CONSTRAINT "knowledge_consumption_knowledge_id_knowledge_records_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_knowledge_id_knowledge_records_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD CONSTRAINT "knowledge_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_from_id_knowledge_records_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."knowledge_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_to_id_knowledge_records_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."knowledge_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_subscriptions" ADD CONSTRAINT "knowledge_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_subscriptions" ADD CONSTRAINT "knowledge_subscriptions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consumption_knowledge_idx" ON "knowledge_consumption" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "consumption_task_idx" ON "knowledge_consumption" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "evidence_knowledge_idx" ON "knowledge_evidence" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "knowledge_project_idx" ON "knowledge_records" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_fingerprint_idx" ON "knowledge_records" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "knowledge_search_idx" ON "knowledge_records" USING gin ("search");--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "knowledge_relations" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "subscriptions_project_idx" ON "knowledge_subscriptions" USING btree ("project_id");