"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Spec = { id: string; label: string; kind: string; required: boolean };

/**
 * Field editor + review actions. Edits are saved explicitly, never autosaved, so the reviewer sees
 * exactly what they committed before approving. Values that failed grounding were blanked by the
 * pipeline and are flagged so the reviewer checks the PDF for them.
 */
export function ReviewPanel(props: { id: string; status: string; specs: Spec[]; values: Record<string, string>; missing: string[]; ungrounded: string[] }) {
  const router = useRouter();
  const [values, setValues] = useState(props.values);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editable = props.status === "needs_review";

  const call = (method: "PATCH" | "POST", body: unknown) =>
    start(async () => {
      setError(null);
      const res = await fetch(`/api/inbox/${props.id}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
        return;
      }
      setDirty(new Set());
      router.refresh();
    });

  return (
    <section className="card space-y-4 p-4" aria-labelledby="fields-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="fields-h" className="font-semibold">Extracted fields</h2>
        <div className="flex flex-wrap gap-2">
          {editable && (
            <>
              <button type="button" className="btn btn-ghost" disabled={pending || dirty.size === 0}
                onClick={() => call("PATCH", { fields: Object.fromEntries([...dirty].map((k) => [k, values[k] === "" ? null : values[k]])) })}>
                Save edits{dirty.size ? ` (${dirty.size})` : ""}
              </button>
              <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => call("POST", { action: "reject" })}>Reject</button>
              <button type="button" className="btn btn-primary" disabled={pending || dirty.size > 0} title={dirty.size ? "Save edits first" : undefined}
                onClick={() => call("POST", { action: "approve" })}>Approve</button>
            </>
          )}
          {(props.status === "failed" || props.status === "quarantined") && (
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => call("POST", { action: "replay" })}>
              {props.status === "quarantined" ? "Release & process" : "Retry"}
            </button>
          )}
          {(props.status === "approved" || props.status === "rejected") && (
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => call("POST", { action: "reopen" })}>Reopen</button>
          )}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-[var(--color-bad)]">{error}</p>}
      {pending && <p aria-live="polite" className="text-sm text-[var(--color-muted)]">Working… a retry runs the local model and can take a minute.</p>}

      {props.specs.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No fields: this document was not recognised as an intake form, tax return or financial statement.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {props.specs.map((s) => {
            const flag = props.ungrounded.includes(s.id) ? "not found in PDF, check" : props.missing.includes(s.id) ? "required, missing" : null;
            return (
              <label key={s.id} className="block text-sm">
                <span className="mb-1 flex items-center gap-2 font-medium">
                  {s.label}
                  {s.required && <span aria-hidden className="text-[var(--color-muted)]">*</span>}
                  {flag && <span className="text-xs font-normal text-[var(--color-warn)]">{flag}</span>}
                </span>
                <input className="input" value={values[s.id] ?? ""} disabled={!editable || pending}
                  inputMode={s.kind === "money" || s.kind === "year" || s.kind === "number" ? "decimal" : undefined}
                  placeholder={s.kind === "date" ? "YYYY-MM-DD" : undefined}
                  onChange={(e) => { setValues({ ...values, [s.id]: e.target.value }); setDirty(new Set(dirty).add(s.id)); }} />
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
