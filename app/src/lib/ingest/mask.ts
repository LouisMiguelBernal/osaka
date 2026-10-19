import type { ExtractableDocType, ExtractedFields, FieldValue } from "./schemas";
import { FIELD_SPECS } from "./schemas";
import { decrypt, encrypt, isEncrypted } from "@/lib/crypto";

/**
 * PII boundary for extracted fields.
 *
 *   at rest   → taxId fields encrypted (lib/crypto.ts, AES-256-GCM)
 *   outbound  → taxId fields masked to the last 4 digits (n8n, Sheets, Drive names, email)
 *
 * `assertNoTaxIds` is the last gate before anything leaves the app: it scans the
 * serialized payload for SSN/EIN-shaped digit runs and throws, so a future field
 * added without `kind: "taxId"` fails loudly instead of leaking.
 */

export const maskTaxId = (v: string): string => {
  const digits = v.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-••-${digits.slice(-4)}` : "•••";
};

const taxIdKeys = (type: ExtractableDocType): string[] =>
  FIELD_SPECS[type].filter((s) => s.kind === "taxId").map((s) => s.id);

export function encryptForStorage(type: ExtractableDocType, fields: ExtractedFields): ExtractedFields {
  const out = { ...fields };
  for (const k of taxIdKeys(type)) {
    const v = out[k];
    if (typeof v === "string" && v && !isEncrypted(v)) out[k] = encrypt(v);
  }
  return out;
}

export function decryptFromStorage(type: ExtractableDocType, fields: ExtractedFields): ExtractedFields {
  const out = { ...fields };
  for (const k of taxIdKeys(type)) {
    const v = out[k];
    if (typeof v === "string" && isEncrypted(v)) out[k] = decrypt(v);
  }
  return out;
}

/** Fields safe to send outside the app. Works on plaintext or stored (encrypted) values. */
export function outboundFields(type: ExtractableDocType, fields: ExtractedFields): ExtractedFields {
  const out: ExtractedFields = { ...fields };
  for (const k of taxIdKeys(type)) {
    const v: FieldValue = out[k];
    if (v == null) continue;
    out[k] = isEncrypted(v) ? "•••-••-••••" : maskTaxId(String(v));
  }
  return out;
}

// SSN 123-45-6789 / 123456789, EIN 12-3456789. Bounded so dollar amounts with
// separators ("1,234,567") and ISO dates never match.
const TAX_ID_PATTERNS = [/(?<![\d,.-])\d{3}-\d{2}-\d{4}(?![\d-])/, /(?<![\d,.-])\d{2}-\d{7}(?![\d-])/, /(?<![\d,.$-])\d{9}(?![\d.,])/];

export function findTaxIdLike(serialized: string): string | null {
  for (const re of TAX_ID_PATTERNS) {
    const m = re.exec(serialized);
    if (m) return m[0];
  }
  return null;
}

/** Scans string leaves only: tax IDs are always strings, and a 9-digit dollar amount is a number, not an EIN. */
export function assertNoTaxIds(payload: unknown): void {
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (findTaxIdLike(v)) throw new Error("Outbound payload contains an unmasked SSN/EIN-shaped value");
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(payload);
}
