export type Tone = "ok" | "warn" | "bad" | "info";

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  received: { label: "Processing", tone: "info" },
  needs_review: { label: "Needs review", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "info" },
  failed: { label: "Failed", tone: "bad" },
  quarantined: { label: "Quarantined", tone: "bad" },
};

export const fmtDate = (d: Date) =>
  d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const pct = (v: string | number | null) => (v == null ? "—" : `${Math.round(Number(v) * 100)}%`);
