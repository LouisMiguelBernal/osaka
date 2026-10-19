import { NextResponse } from "next/server";
import { sha256Hex, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "@/lib/ingest/hmac";
import { parseSenderAuth } from "@/lib/ingest/policy";
import { ingest } from "@/lib/ingest/service";
import { MAX_FILE_BYTES } from "@/lib/storage";

/**
 * POST /api/ingest/process: n8n hands over one (message, PDF) pair as multipart/form-data.
 *
 * Machine-to-machine, so no session. Authorised by an HMAC over
 * [messageId, sha256(file), senderEmail, senderAuth(, "local")] with OSAKA_INGEST_SECRET. The
 * server hashes the bytes it actually received, so a swapped file fails like a forged signature,
 * and a local drop signs an extra part so an email request can't be replayed as "local".
 *
 * Synchronous on purpose: the local model takes seconds to minutes and n8n waits (300 s timeout,
 * one item at a time). The response is the masked summary that drives the result file, Drive,
 * Sheets and the reply email.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

const field = (form: FormData, k: string): string => {
  const v = form.get(k);
  return typeof v === "string" ? v.trim() : "";
};

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 25 MB)." }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "File too large (max 25 MB)." }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const messageId = field(form, "messageId");
  const senderEmail = field(form, "senderEmail");
  const senderAuth = field(form, "senderAuth");
  const source = field(form, "source") === "local" ? "local" : "email";

  const verdict = verifySignature({
    secret: process.env.OSAKA_INGEST_SECRET,
    timestamp: req.headers.get(TIMESTAMP_HEADER),
    signature: req.headers.get(SIGNATURE_HEADER),
    parts: [messageId, sha256Hex(bytes), senderEmail, senderAuth, ...(source === "local" ? ["local"] : [])],
  });
  if (!verdict.ok) {
    console.warn("[ingest] rejected signature:", verdict.reason);
    return NextResponse.json({ error: "Unauthorized" }, { status: verdict.reason === "unconfigured" ? 503 : 401 });
  }
  if (!messageId || !senderEmail) return NextResponse.json({ error: "messageId and senderEmail are required" }, { status: 400 });

  try {
    const summary = await ingest({
      file: bytes,
      fileName: file.name || field(form, "fileName") || "attachment.pdf",
      senderEmail,
      senderName: field(form, "senderName") || null,
      subject: field(form, "subject") || null,
      messageId,
      threadId: field(form, "threadId") || null,
      senderAuth: parseSenderAuth(senderAuth),
      source,
    });
    // Ids and outcome only. Never field values.
    console.log("[ingest]", { id: summary.extractionId, status: summary.status, docType: summary.docType, duplicate: summary.duplicate });
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[ingest] error:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
  }
}
