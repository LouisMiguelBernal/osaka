import { NextResponse } from "next/server";
import { z } from "zod";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "@/lib/ingest/hmac";
import { ackFanout, Conflict, NotFound } from "@/lib/ingest/service";
import { FANOUT_TARGETS } from "@/lib/ingest/state";

/**
 * POST /api/ingest/fanout-ack: n8n reports a side effect happened (Drive upload, Sheet row, reply).
 * Recorded once per target; `alreadyDone` lets a retried run skip it. HMAC over [id, target, ref].
 */
export const runtime = "nodejs";

const body = z.object({
  extractionId: z.string().uuid(),
  target: z.enum(FANOUT_TARGETS),
  ref: z.union([z.string().min(1).max(300), z.literal(true)]),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(JSON.parse(await req.text()));
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const verdict = verifySignature({
    secret: process.env.OSAKA_INGEST_SECRET,
    timestamp: req.headers.get(TIMESTAMP_HEADER),
    signature: req.headers.get(SIGNATURE_HEADER),
    parts: [parsed.extractionId, parsed.target, String(parsed.ref)],
  });
  if (!verdict.ok) return NextResponse.json({ error: "Unauthorized" }, { status: verdict.reason === "unconfigured" ? 503 : 401 });

  try {
    return NextResponse.json({ ok: true, ...(await ackFanout(parsed.extractionId, parsed.target, parsed.ref)) });
  } catch (err) {
    if (err instanceof NotFound) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (err instanceof Conflict) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
