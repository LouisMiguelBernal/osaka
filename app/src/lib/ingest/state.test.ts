import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, INGEST_STATUSES, isFanoutTarget, isIngestStatus } from "./state";

describe("ingest state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("received", "needs_review")).toBe(true);
    expect(canTransition("needs_review", "approved")).toBe(true);
  });

  it("allows replay and release, and reopening a decision", () => {
    expect(canTransition("failed", "received")).toBe(true);
    expect(canTransition("quarantined", "received")).toBe(true);
    expect(canTransition("approved", "needs_review")).toBe(true);
  });

  it("rejects skipping review or approving a failure", () => {
    expect(canTransition("received", "approved")).toBe(false);
    expect(canTransition("failed", "approved")).toBe(false);
    expect(() => assertTransition("quarantined", "approved")).toThrow(/Illegal/);
  });

  it("every status has a defined exit", () => {
    for (const s of INGEST_STATUSES) expect(INGEST_STATUSES.some((t) => canTransition(s, t))).toBe(true);
  });

  it("guards", () => {
    expect(isIngestStatus("needs_review")).toBe(true);
    expect(isIngestStatus("done")).toBe(false);
    expect(isFanoutTarget("reply")).toBe(true);
    expect(isFanoutTarget("fax")).toBe(false);
  });
});
