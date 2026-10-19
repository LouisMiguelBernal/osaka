import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional HTTP basic auth for the dashboard. Off unless DASHBOARD_USER and DASHBOARD_PASSWORD are
 * set (the app binds to 127.0.0.1 by default). Machine routes are excluded: /api/ingest/* verifies
 * an HMAC on every request and /api/files verifies a signed, expiring link.
 */
export function proxy(req: NextRequest) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, ...rest] = atob(encoded).split(":");
    if (u === user && rest.join(":") === pass) return NextResponse.next();
  }
  return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="OSAKA"' } });
}

export const config = { matcher: ["/((?!api/ingest|api/files|_next|favicon).*)"] };
