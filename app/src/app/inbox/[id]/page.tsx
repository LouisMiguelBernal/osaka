import Link from "next/link";
import { notFound } from "next/navigation";
import { getForReview } from "@/lib/ingest/service";
import type { CheckResult } from "@/lib/ingest/checks";
import { DOC_TYPE_LABELS, FIELD_SPECS, isDocType } from "@/lib/ingest/schemas";
import { signedFileUrl } from "@/lib/storage";
import { fmtDate, pct, STATUS } from "../status";
import { ReviewPanel } from "./ReviewPanel";

export const metadata = { title: "Document" };
export const dynamic = "force-dynamic";

const CHECK_TONE = { pass: "ok", fail: "bad", skip: "info" } as const;

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getForReview(id);
  if (!data) notFound();
  const { row, type, fields, client } = data;
  const specs = type ? FIELD_SPECS[type] : [];
  const checks = (row.checks ?? []) as CheckResult[];
  const fanout = Object.keys((row.fanout ?? {}) as object);

  const facts: [string, React.ReactNode][] = [
    ["Confidence", pct(row.confidence)],
    ["Client", client ? client.name || client.email : "—"],
    ["Source", row.source === "local" ? "Folder drop" : `Email (sender auth: ${row.senderAuth})`],
    ["Pages", `${row.pageCount ?? "—"}${row.usedVision ? " · scanned, read from images" : ""}`],
    ["Model", row.model ? `${row.model}${row.modelDigest ? ` (${row.modelDigest.slice(0, 12)})` : ""}` : "—"],
    ["Time", row.durationMs != null ? `${(row.durationMs / 1000).toFixed(1)} s` : "—"],
    ["Versions", `prompt ${row.promptVersion ?? "—"} · schema ${row.schemaVersion ?? "—"}`],
    ["Delivered to", fanout.length ? fanout.join(", ") : "—"],
  ];

  return (
    <div className="space-y-6">
      <Link href="/inbox" className="link text-sm">← Inbox</Link>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="break-all text-2xl font-bold">{row.fileName}</h1>
          <span className="badge" data-tone={STATUS[row.status]?.tone ?? "info"}>{STATUS[row.status]?.label ?? row.status}</span>
        </div>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {isDocType(row.docType) ? DOC_TYPE_LABELS[row.docType] : "Not classified"} · from {row.senderEmail} · {fmtDate(row.createdAt)}
        </p>
      </div>

      {(row.status === "failed" || row.status === "quarantined") && row.failedReason && (
        <div role="alert" className="card border-l-4 border-l-[var(--color-bad)] p-4 text-sm">
          <strong>{row.status === "failed" ? `Failed at ${row.failedStage ?? "unknown stage"}` : "Quarantined"}:</strong> {row.failedReason}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <aside className="space-y-4">
          <section className="card space-y-3 p-4 text-sm">
            <h2 className="font-semibold">Details</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {facts.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[var(--color-muted)]">{k}</dt>
                  <dd className="break-words">{v}</dd>
                </div>
              ))}
            </dl>
            {row.storageKey && (
              <a href={signedFileUrl(row.storageKey)} target="_blank" rel="noopener noreferrer" className="btn btn-primary inline-flex">Open PDF</a>
            )}
          </section>
          {row.classifyReason && (
            <section className="card p-4 text-sm">
              <h2 className="mb-1 font-semibold">Why this type</h2>
              <p className="text-[var(--color-muted)]">{row.classifyReason}</p>
            </section>
          )}
          {checks.length > 0 && (
            <section className="card p-4 text-sm">
              <h2 className="mb-2 font-semibold">Cross-checks</h2>
              <ul className="space-y-2">
                {checks.map((c) => (
                  <li key={c.id}>
                    <span className="badge" data-tone={CHECK_TONE[c.status]}>{c.status}</span> <span className="font-medium">{c.id.replace(/_/g, " ")}</span>
                    <div className="text-xs text-[var(--color-muted)]">{c.detail}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {row.warnings.length > 0 && (
            <section className="card p-4 text-sm">
              <h2 className="mb-1 font-semibold">Warnings</h2>
              <ul className="list-disc space-y-1 pl-5 text-[var(--color-muted)]">{row.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </section>
          )}
        </aside>

        <ReviewPanel
          id={row.id}
          status={row.status}
          specs={specs.map((s) => ({ id: s.id, label: s.label, kind: s.kind, required: Boolean(s.required) }))}
          values={Object.fromEntries(specs.map((s) => [s.id, fields[s.id] == null ? "" : String(fields[s.id])]))}
          missing={row.missingFields}
          ungrounded={row.ungrounded}
        />
      </div>
    </div>
  );
}
