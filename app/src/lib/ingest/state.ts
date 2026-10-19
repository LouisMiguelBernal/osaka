/**
 * Lifecycle of an extractions row. The DB is the source of truth; n8n
 * only drives transitions through the ingest routes.
 *
 *   received ──► needs_review ──► approved
 *      │  │            ▲   └────► rejected
 *      │  └► failed ───┤ (replay → received)
 *      └──► quarantined┘ (operator release → received)
 *
 * approved / rejected can be reopened to needs_review by an operator.
 */
export const INGEST_STATUSES = [
  "received",
  "quarantined",
  "failed",
  "needs_review",
  "approved",
  "rejected",
] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** Where in the pipeline a failure happened — drives replay and the operator alert. */
export const FAILURE_STAGES = ["validate_file", "classify", "extract", "store"] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

const TRANSITIONS: Record<IngestStatus, readonly IngestStatus[]> = {
  received: ["needs_review", "failed", "quarantined"],
  failed: ["received"],
  quarantined: ["received", "rejected"],
  needs_review: ["approved", "rejected"],
  approved: ["needs_review"],
  rejected: ["needs_review"],
};

export const isIngestStatus = (v: unknown): v is IngestStatus =>
  typeof v === "string" && (INGEST_STATUSES as readonly string[]).includes(v);

export const canTransition = (from: IngestStatus, to: IngestStatus): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: IngestStatus, to: IngestStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal ingest transition ${from} → ${to}`);
  }
}

/** Fan-out targets n8n reports back. Each is recorded once; repeats are no-ops. */
export const FANOUT_TARGETS = ["drive", "sheets", "reply"] as const;
export type FanoutTarget = (typeof FANOUT_TARGETS)[number];
export type FanoutState = Partial<Record<FanoutTarget, string | true>>;

export const isFanoutTarget = (v: unknown): v is FanoutTarget =>
  typeof v === "string" && (FANOUT_TARGETS as readonly string[]).includes(v);

/** Statuses whose document may be fanned out (Drive/Sheets/reply). */
export const FANOUT_ELIGIBLE: ReadonlySet<IngestStatus> = new Set(["needs_review", "approved"]);
