import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clients, documents, extractions, records } from "@/lib/schema";
import type { Extraction } from "@/lib/schema";
import { getFile, putFile, sanitizeFileName } from "@/lib/storage";
import { sha256Hex } from "./hmac";
import { decryptFromStorage, encryptForStorage } from "./mask";
import { createOllama } from "./ollama";
import type { Llm } from "./ollama";
import { unpdfReader } from "./pdf";
import type { PdfReader } from "./pdf";
import { PipelineError, runPipeline } from "./pipeline";
import { decideSender, normaliseEmail, parseAllowlist } from "./policy";
import type { SenderAuth } from "./policy";
import { buildSummary } from "./present";
import type { IngestSummary } from "./present";
import { PROMPT_VERSION } from "./prompts";
import type { ExtractableDocType, ExtractedFields } from "./schemas";
import { coerceField, FIELD_SPECS, isDocType, missingRequired, SCHEMA_VERSION } from "./schemas";
import type { FanoutTarget, IngestStatus } from "./state";
import { assertTransition, FANOUT_ELIGIBLE, isIngestStatus } from "./state";

/**
 * Persistence and orchestration for the ingest pipeline. Routes stay thin (auth + parsing); every
 * state change happens here.
 */

const appUrl = () => process.env.APP_URL || "http://localhost:3030";

export type Deps = { llm: Llm; reader: PdfReader };
export const defaultDeps = (): Deps => ({ llm: createOllama(), reader: unpdfReader });

export class NotFound extends Error {
  constructor() {
    super("Not found");
  }
}
export class Conflict extends Error {}

export type IngestInput = {
  file: Uint8Array;
  fileName: string;
  senderEmail: string;
  senderName: string | null;
  subject: string | null;
  messageId: string;
  threadId: string | null;
  senderAuth: SenderAuth;
  /** "local" = dropped into the watched folder on this machine: an operator action, so the email sender policy does not apply. */
  source: "email" | "local";
};

async function findClient(email: string) {
  const [c] = await db.select().from(clients).where(eq(clients.email, email)).limit(1);
  return c ?? null;
}

async function ensureClient(email: string, name: string | null) {
  const [c] = await db
    .insert(clients)
    .values({ email, name })
    .onConflictDoUpdate({ target: clients.email, set: { name: sql`coalesce(${clients.name}, excluded.name)` } })
    .returning();
  return c;
}

async function load(id: string): Promise<Extraction> {
  const [r] = await db.select().from(extractions).where(eq(extractions.id, id)).limit(1);
  if (!r) throw new NotFound();
  return r;
}

async function update(id: string, set: Partial<typeof extractions.$inferInsert>): Promise<Extraction> {
  const [r] = await db.update(extractions).set({ ...set, updatedAt: new Date() }).where(eq(extractions.id, id)).returning();
  return r;
}

async function summarise(row: Extraction, duplicate: boolean, senderName: string | null = null): Promise<IngestSummary> {
  const client = row.clientId ? (await db.select().from(clients).where(eq(clients.id, row.clientId)).limit(1))[0] : null;
  return buildSummary({ row, clientName: client?.name ?? null, senderName, duplicate, baseUrl: appUrl() });
}

/**
 * Entry point for one (message, PDF) pair. Idempotent on (messageId, sha256): a repeat returns the
 * existing row untouched, unless that row had failed, in which case it is processed again.
 */
export async function ingest(input: IngestInput, deps: Deps = defaultDeps()): Promise<IngestSummary> {
  const sha = sha256Hex(input.file);
  const senderEmail = normaliseEmail(input.senderEmail);

  const [inserted] = await db
    .insert(extractions)
    .values({
      source: input.source,
      messageId: input.messageId,
      threadId: input.threadId,
      senderEmail,
      senderAuth: input.senderAuth,
      subject: input.subject?.slice(0, 500) ?? null,
      sha256: sha,
      fileName: sanitizeFileName(input.fileName || "attachment.pdf"),
    })
    .onConflictDoNothing({ target: [extractions.messageId, extractions.sha256] })
    .returning();

  let row = inserted;
  if (!row) {
    const [existing] = await db
      .select()
      .from(extractions)
      .where(and(eq(extractions.messageId, input.messageId), eq(extractions.sha256, sha)))
      .limit(1);
    if (existing.status !== "failed") return summarise(existing, true, input.senderName);
    row = await update(existing.id, { status: "received", failedStage: null, failedReason: null });
  }

  // Keep the bytes whatever happens next, so a release or replay never needs a resend.
  if (!row.storageKey) {
    const key = `inbox/${sha.slice(0, 2)}/${sha}/${row.fileName}`;
    try {
      await putFile(key, input.file);
    } catch {
      return summarise(await update(row.id, { status: "failed", failedStage: "store", failedReason: "Could not store the file." }), false);
    }
    row = await update(row.id, { storageKey: key });
  }

  if (input.source === "email") {
    const decision = decideSender({
      email: senderEmail,
      auth: input.senderAuth,
      knownClient: Boolean(await findClient(senderEmail)),
      allowlist: parseAllowlist(process.env.OSAKA_SENDER_ALLOWLIST),
      requireAuth: process.env.OSAKA_REQUIRE_SENDER_AUTH !== "0",
    });
    if (!decision.accept) return summarise(await update(row.id, { status: "quarantined", failedReason: decision.reason }), false);
  }

  return process_(row, input.file, input.senderName, deps);
}

/** Run the pipeline on a stored row (fresh ingest, replay, or operator release). */
async function process_(row: Extraction, file: Uint8Array, senderName: string | null, deps: Deps): Promise<IngestSummary> {
  const client = await ensureClient(row.senderEmail, senderName);
  const started = Date.now();
  try {
    const result = await runPipeline(file, deps);
    const digest = await deps.llm.digest();
    const updated = await db.transaction(async (tx) => {
      let documentId = row.documentId;
      if (!documentId) {
        const [doc] = await tx
          .insert(documents)
          .values({ clientId: client.id, category: result.docType, storageKey: row.storageKey!, fileName: row.fileName, sizeBytes: file.byteLength, sha256: row.sha256 })
          .returning({ id: documents.id });
        documentId = doc.id;
      }
      const [r] = await tx
        .update(extractions)
        .set({
          documentId,
          clientId: client.id,
          docType: result.docType,
          classifyReason: result.classifyReason,
          status: "needs_review",
          failedStage: null,
          failedReason: null,
          fields: result.docType === "other" ? {} : encryptForStorage(result.docType, result.fields),
          ungrounded: result.ungrounded,
          missingFields: result.missingFields,
          warnings: result.warnings,
          checks: result.checks,
          confidence: String(result.confidence),
          pageCount: result.pageCount,
          usedVision: result.usedVision,
          model: deps.llm.model,
          modelDigest: digest,
          promptVersion: PROMPT_VERSION,
          schemaVersion: SCHEMA_VERSION,
          durationMs: Date.now() - started,
          updatedAt: new Date(),
        })
        .where(eq(extractions.id, row.id))
        .returning();
      return r;
    });
    return summarise(updated, false, senderName);
  } catch (err) {
    const failed = await update(row.id, {
      clientId: client.id,
      status: "failed",
      failedStage: err instanceof PipelineError ? err.stage : "store",
      failedReason: (err instanceof Error ? err.message : "Unknown error").slice(0, 500),
      durationMs: Date.now() - started,
    });
    return summarise(failed, false, senderName);
  }
}

/** Re-run a failed row, or release a quarantined one (bypasses sender policy by design). */
export async function replay(id: string, deps: Deps = defaultDeps()): Promise<IngestSummary> {
  const row = await load(id);
  assertTransition(row.status as IngestStatus, "received");
  if (!row.storageKey) throw new Conflict("No stored file to replay.");
  const file = await getFile(row.storageKey);
  return process_(await update(id, { status: "received", failedStage: null, failedReason: null }), file, null, deps);
}

/** n8n reports a completed side effect. Idempotent: a second ack for the same target is a no-op. */
export async function ackFanout(id: string, target: FanoutTarget, ref: string | true): Promise<{ alreadyDone: boolean }> {
  const row = await load(id);
  if (!FANOUT_ELIGIBLE.has(row.status as IngestStatus) && target !== "reply") throw new Conflict(`Row is ${row.status}; ${target} not allowed.`);
  if ((row.fanout as Record<string, unknown>)[target]) return { alreadyDone: true };
  // Merged in SQL so concurrent acks for different targets cannot overwrite each other.
  await db
    .update(extractions)
    .set({ fanout: sql`${extractions.fanout} || ${JSON.stringify({ [target]: ref })}::jsonb`, updatedAt: new Date() })
    .where(eq(extractions.id, id));
  return { alreadyDone: false };
}

/** Dashboard view: plaintext fields for the operator (tax IDs decrypted). */
export async function getForReview(id: string) {
  const row = await load(id).catch(() => null);
  if (!row) return null;
  const type = isDocType(row.docType) && row.docType !== "other" ? row.docType : null;
  const fields = type ? decryptFromStorage(type, row.fields as ExtractedFields) : {};
  const client = row.clientId ? (await db.select().from(clients).where(eq(clients.id, row.clientId)).limit(1))[0] ?? null : null;
  return { row, type, fields, client };
}

/** Operator corrects values before approving. Re-coerced and re-encrypted; an edited value counts as verified. */
export async function editFields(id: string, edits: Record<string, unknown>, actor: string) {
  const row = await load(id);
  if (row.status !== "needs_review") throw new Conflict("Only rows awaiting review can be edited.");
  if (!isDocType(row.docType) || row.docType === "other") throw new Conflict("Nothing to edit on an unclassified document.");
  const type: ExtractableDocType = row.docType;
  const current = decryptFromStorage(type, row.fields as ExtractedFields);
  const edited: string[] = [];
  for (const spec of FIELD_SPECS[type]) {
    if (spec.id in edits) {
      current[spec.id] = coerceField(spec, edits[spec.id] === "" ? null : edits[spec.id]);
      edited.push(spec.id);
    }
  }
  return update(id, {
    fields: encryptForStorage(type, current),
    missingFields: missingRequired(type, current),
    ungrounded: row.ungrounded.filter((u) => !edited.includes(u)),
    reviewedBy: actor,
  });
}

/** Approve / reject / reopen. Approval is the only path by which extracted data becomes a record. */
export async function review(id: string, to: IngestStatus, actor: string) {
  const row = await load(id);
  if (!isIngestStatus(row.status)) throw new Conflict("Unknown status");
  assertTransition(row.status, to);
  return db.transaction(async (tx) => {
    if (to === "approved" && row.clientId && isDocType(row.docType) && row.docType !== "other") {
      await tx
        .insert(records)
        .values({ extractionId: row.id, clientId: row.clientId, docType: row.docType, data: row.fields, approvedBy: actor })
        .onConflictDoUpdate({ target: records.extractionId, set: { data: row.fields, approvedBy: actor, approvedAt: new Date() } });
    }
    if (to === "needs_review") await tx.delete(records).where(eq(records.extractionId, row.id));
    const [r] = await tx
      .update(extractions)
      .set({ status: to, reviewedAt: to === "needs_review" ? null : new Date(), reviewedBy: actor, updatedAt: new Date() })
      .where(eq(extractions.id, id))
      .returning();
    return r;
  });
}
