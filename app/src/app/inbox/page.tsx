import Link from "next/link";
import { and, count, desc, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { extractions } from "@/lib/schema";
import { DOC_TYPE_LABELS, DOC_TYPES, isDocType } from "@/lib/ingest/schemas";
import { INGEST_STATUSES, isIngestStatus } from "@/lib/ingest/state";
import { fmtDate, pct, STATUS } from "./status";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = isIngestStatus(sp.status) ? sp.status : undefined;
  const type = isDocType(sp.type) ? sp.type : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;

  const where: SQL[] = [];
  if (status) where.push(eq(extractions.status, status));
  if (type) where.push(eq(extractions.docType, type));
  if (q) where.push(ilike(extractions.senderEmail, `%${q.replace(/[%_]/g, "")}%`));

  const [rows, counts] = await Promise.all([
    db.select().from(extractions).where(where.length ? and(...where) : undefined).orderBy(desc(extractions.createdAt)).limit(200),
    db.select({ status: extractions.status, n: count() }).from(extractions).groupBy(extractions.status),
  ]);
  const countOf = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, type, q, ...patch })) if (v) p.set(k, v);
    return p.size ? `/inbox?${p}` : "/inbox";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inbox</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          PDFs received by email or folder drop, read by the local model. Nothing becomes a record until you approve it.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Filter by status">
        <Link href={href({ status: undefined })} className="chip" data-active={!status}>All</Link>
        {INGEST_STATUSES.map((s) => (
          <Link key={s} href={href({ status: s })} className="chip" data-active={status === s}>
            {STATUS[s].label} <span className="opacity-70">{countOf[s] ?? 0}</span>
          </Link>
        ))}
      </div>

      <form className="flex flex-wrap gap-3" action="/inbox">
        {status && <input type="hidden" name="status" value={status} />}
        <label className="sr-only" htmlFor="f-type">Document type</label>
        <select id="f-type" name="type" defaultValue={type ?? ""} className="input max-w-56">
          <option value="">All types</option>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-q">Sender</label>
        <input id="f-q" name="q" defaultValue={q} placeholder="Sender email contains…" className="input max-w-72" />
        <button className="btn btn-primary" type="submit">Filter</button>
      </form>

      {rows.length === 0 ? (
        <div className="card p-6 text-sm text-[var(--color-muted)]">
          Nothing here yet. Drop a PDF into <code>osaka-inbox/</code> and it appears within seconds.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-line)]">
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Document</th>
                <th className="px-4 py-3">Sender</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Gaps</th>
                <th className="px-4 py-3">Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-line)] align-top last:border-0">
                  <td className="px-4 py-3"><span className="badge" data-tone={STATUS[r.status]?.tone ?? "info"}>{STATUS[r.status]?.label ?? r.status}</span></td>
                  <td className="max-w-xs px-4 py-3">
                    <Link href={`/inbox/${r.id}`} className="link break-words font-medium">{r.fileName}</Link>
                    <div className="text-xs text-[var(--color-muted)]">
                      {isDocType(r.docType) ? DOC_TYPE_LABELS[r.docType] : "Not classified"}
                      {r.usedVision ? " · scanned" : ""} · {r.source === "local" ? "folder drop" : "email"}
                    </div>
                  </td>
                  <td className="max-w-xs break-words px-4 py-3">{r.senderEmail}</td>
                  <td className="px-4 py-3">{pct(r.confidence)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">{r.missingFields.length} missing · {r.ungrounded.length} unverified</td>
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
