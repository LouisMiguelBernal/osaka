CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"category" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid,
	"client_id" uuid,
	"source" text DEFAULT 'email' NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text,
	"sender_email" text NOT NULL,
	"sender_auth" text DEFAULT 'none' NOT NULL,
	"subject" text,
	"sha256" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text,
	"doc_type" text,
	"classify_reason" text,
	"status" text DEFAULT 'received' NOT NULL,
	"failed_stage" text,
	"failed_reason" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ungrounded" text[] DEFAULT '{}'::text[] NOT NULL,
	"missing_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"page_count" integer,
	"used_vision" boolean DEFAULT false NOT NULL,
	"model" text,
	"model_digest" text,
	"prompt_version" text,
	"schema_version" text,
	"duration_ms" integer,
	"fanout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "records_extraction_id_unique" UNIQUE("extraction_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_client_idx" ON "documents" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_message_sha_unique" ON "extractions" USING btree ("message_id","sha256");--> statement-breakpoint
CREATE INDEX "extractions_status_idx" ON "extractions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "records_client_idx" ON "records" USING btree ("client_id");