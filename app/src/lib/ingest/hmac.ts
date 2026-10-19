import crypto from "node:crypto";

/**
 * Machine-to-machine auth for the ingest routes (n8n → OSAKA).
 *
 * The signature covers a canonical string rather than the raw multipart body,
 * because n8n cannot reproduce multipart boundaries byte-for-byte. The file is
 * bound by its SHA-256, which the server recomputes from the bytes it actually
 * received — a swapped attachment fails verification exactly like a forged
 * signature.
 *
 *   X-Osaka-Timestamp: <unix seconds>
 *   X-Osaka-Signature: sha256=<hex HMAC-SHA256(secret, canonical)>
 *   canonical = "v1\n<timestamp>\n<part>\n<part>…"
 *
 * Replay window: ±300 s. Comparison is constant-time.
 */

export const SIGNATURE_HEADER = "x-osaka-signature";
export const TIMESTAMP_HEADER = "x-osaka-timestamp";
export const MAX_SKEW_SECONDS = 300;

export const canonicalString = (timestamp: string | number, parts: readonly string[]): string =>
  ["v1", String(timestamp), ...parts].join("\n");

export const signCanonical = (secret: string, timestamp: string | number, parts: readonly string[]): string =>
  crypto.createHmac("sha256", secret).update(canonicalString(timestamp, parts)).digest("hex");

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" | "unconfigured" };

export function verifySignature(input: {
  secret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  parts: readonly string[];
  now?: number;
}): VerifyResult {
  if (!input.secret || input.secret.length < 32) return { ok: false, reason: "unconfigured" };
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing" };

  const ts = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };

  const given = input.signature.replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/i.test(given)) return { ok: false, reason: "mismatch" };
  const expected = Buffer.from(signCanonical(input.secret, input.timestamp, input.parts), "hex");
  const actual = Buffer.from(given, "hex");
  return crypto.timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export const sha256Hex = (data: Buffer | Uint8Array): string =>
  crypto.createHash("sha256").update(data).digest("hex");
