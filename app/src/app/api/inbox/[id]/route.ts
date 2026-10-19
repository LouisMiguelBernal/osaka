import { NextResponse } from "next/server";
import { z } from "zod";
import { Conflict, editFields, NotFound, replay, review } from "@/lib/ingest/service";

/**
 * Review actions on one extraction (dashboard only; protected by src/proxy.ts when
 * DASHBOARD_USER/DASHBOARD_PASSWORD are set, and by binding to 127.0.0.1 otherwise).
 *   PATCH { fields: { id: value } }                         edit before approving
 *   POST  { action: "approve" | "reject" | "reopen" | "replay" }
 */
export const runtime = "nodejs";
export const maxDuration = 300;

const patchBody = z.object({ fields: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])) });
const postBody = z.object({ action: z.enum(["approve", "reject", "reopen", "replay"]) });
const actor = () => process.env.DASHBOARD_USER || "operator";

function fail(err: unknown) {
  if (err instanceof NotFound) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (err instanceof Conflict || (err instanceof Error && /Illegal ingest transition/.test(err.message))) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
  console.error("[inbox] error:", err instanceof Error ? err.message : "unknown");
  return NextResponse.json({ error: "Failed" }, { status: 500 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = patchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  try {
    const row = await editFields((await params).id, parsed.data.fields, actor());
    return NextResponse.json({ ok: true, missingFields: row.missingFields });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = postBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { id } = await params;
  try {
    const { action } = parsed.data;
    if (action === "replay") return NextResponse.json({ ok: true, status: (await replay(id)).status });
    const to = action === "approve" ? "approved" : action === "reject" ? "rejected" : "needs_review";
    return NextResponse.json({ ok: true, status: (await review(id, to, actor())).status });
  } catch (err) {
    return fail(err);
  }
}
