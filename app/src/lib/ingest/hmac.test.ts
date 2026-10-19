import { describe, expect, it } from "vitest";
import { canonicalString, sha256Hex, signCanonical, verifySignature } from "./hmac";

const secret = "s".repeat(64);
const now = 1_800_000_000;
const parts = ["msg-1", "a".repeat(64), "isabel@northpointcreative.co"];
const sig = `sha256=${signCanonical(secret, now, parts)}`;

describe("ingest HMAC", () => {
  it("accepts a valid signature within the window", () => {
    expect(verifySignature({ secret, timestamp: String(now - 100), signature: `sha256=${signCanonical(secret, now - 100, parts)}`, parts, now })).toEqual({ ok: true });
    expect(verifySignature({ secret, timestamp: String(now), signature: sig, parts, now })).toEqual({ ok: true });
  });

  it("rejects a tampered part (e.g. swapped attachment hash)", () => {
    const tampered = ["msg-1", "b".repeat(64), "isabel@northpointcreative.co"];
    expect(verifySignature({ secret, timestamp: String(now), signature: sig, parts: tampered, now })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects replays outside ±300 s", () => {
    expect(verifySignature({ secret, timestamp: String(now), signature: sig, parts, now: now + 301 })).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature({ secret, timestamp: "abc", signature: sig, parts, now })).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing headers, malformed signatures and weak/absent secrets", () => {
    expect(verifySignature({ secret, timestamp: null, signature: sig, parts, now })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ secret, timestamp: String(now), signature: "sha256=zz", parts, now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret: undefined, timestamp: String(now), signature: sig, parts, now })).toEqual({ ok: false, reason: "unconfigured" });
    expect(verifySignature({ secret: "short", timestamp: String(now), signature: sig, parts, now })).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("signature without the sha256= prefix is accepted", () => {
    expect(verifySignature({ secret, timestamp: String(now), signature: sig.slice(7), parts, now })).toEqual({ ok: true });
  });

  it("canonical form and hashing are stable", () => {
    expect(canonicalString(1, ["a", "b"])).toBe("v1\n1\na\nb");
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
