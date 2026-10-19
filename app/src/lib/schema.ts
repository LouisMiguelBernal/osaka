import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** A person or business that sends documents. Created on first contact, keyed by email. */
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A stored PDF. Bytes live on disk under STORAGE_DIR; only the opaque key is kept here. */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    category: text("category").notNull(), // intake | tax_return | financial_statement | other
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("documents_client_idx").on(t.clientId)],
);

/**
 * One row per (message, PDF) the pipeline received — the source of truth for where a document is
 * in its lifecycle (see lib/ingest/state.ts). n8n only orchestrates; it reports side effects back
 * through /api/ingest/fanout-ack so a retried run never repeats a reply or a Sheet row.
 *
 * Idempotency key: (message_id, sha256). `fields` holds extracted values with tax IDs encrypted.
 */
export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    source: text("source").notNull().default("email"), // email | local
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    senderEmail: text("sender_email").notNull(),
    senderAuth: text("sender_auth").notNull().default("none"),
    subject: text("subject"),
    sha256: text("sha256").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key"),
    docType: text("doc_type"),
    classifyReason: text("classify_reason"),
    status: text("status").notNull().default("received"),
    failedStage: text("failed_stage"),
    failedReason: text("failed_reason"),
    fields: jsonb("fields").notNull().default(sql`'{}'::jsonb`),
    ungrounded: text("ungrounded").array().notNull().default(sql`'{}'::text[]`),
    missingFields: text("missing_fields").array().notNull().default(sql`'{}'::text[]`),
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
    checks: jsonb("checks").notNull().default(sql`'[]'::jsonb`),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    pageCount: integer("page_count"),
    usedVision: boolean("used_vision").notNull().default(false),
    model: text("model"),
    modelDigest: text("model_digest"),
    promptVersion: text("prompt_version"),
    schemaVersion: text("schema_version"),
    durationMs: integer("duration_ms"),
    fanout: jsonb("fanout").notNull().default(sql`'{}'::jsonb`),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("extractions_message_sha_unique").on(t.messageId, t.sha256),
    index("extractions_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * Review gate output: the human-approved version of an extraction. Model output becomes client
 * data only here, and only by an explicit approve action. Tax IDs stay encrypted.
 */
export const records = pgTable(
  "records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    extractionId: uuid("extraction_id").notNull().references(() => extractions.id, { onDelete: "cascade" }).unique(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    data: jsonb("data").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("records_client_idx").on(t.clientId)],
);

export type Extraction = typeof extractions.$inferSelect;
