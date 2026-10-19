import { NextResponse } from "next/server";
import { getFile, sanitizeFileName, verifyFileUrl } from "@/lib/storage";

/** GET /api/files?key&exp&sig: serves a stored PDF behind a short-lived signature minted by the dashboard. */
export const runtime = "nodejs";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const key = q.get("key") ?? "";
  if (!verifyFileUrl({ key, exp: q.get("exp") ?? "", sig: q.get("sig") ?? "" })) {
    return NextResponse.json({ error: "Link expired or invalid" }, { status: 403 });
  }
  let body: Buffer;
  try {
    body = await getFile(key);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const name = sanitizeFileName(key.split("/").pop() ?? "document.pdf");
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
