import type { ExtractedFields, FieldSpec } from "./schemas";
import { parseAmount } from "./schemas";

/**
 * Grounding: a value the model returns that cannot be found in the document's own text is treated
 * as invented and nulled, so it never reaches the database as a fact. Applies to text-layer PDFs;
 * scanned pages (vision path) have no text to check against and are flagged as unverified instead.
 */

const normText = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@.%/$-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Every number printed in the text, including accounting negatives and k/M suffixes. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /\(?-?[$€£¥₱]?\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\)?/g;
  for (const m of text.match(re) ?? []) {
    const n = parseAmount(m.replace(/\s/g, ""));
    if (n !== null) out.push(Math.abs(n));
  }
  return out;
}

const datesIn = (value: string): string[] => {
  const [y, m, d] = value.split("-").map(Number);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const mon = months[m - 1];
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return [
    value,
    `${mm}/${dd}/${y}`,
    `${m}/${d}/${y}`,
    `${dd}/${mm}/${y}`,
    `${mm}-${dd}-${y}`,
    `${mon} ${d} ${y}`,
    `${mon.slice(0, 3)} ${d} ${y}`,
    `${d} ${mon} ${y}`,
    `${d} ${mon.slice(0, 3)} ${y}`,
  ].map(normText);
};

export type Haystack = { text: string; numbers: number[]; digits: string };

export const buildHaystack = (text: string): Haystack => ({
  text: normText(text),
  numbers: numbersIn(text),
  digits: text.replace(/\D/g, ""),
});

const numberGrounded = (v: number, hay: Haystack): boolean =>
  hay.numbers.some((n) => Math.abs(n - Math.abs(v)) <= Math.max(0.01, Math.abs(v) * 1e-6));

const textGrounded = (v: string, hay: Haystack): boolean => {
  const needle = normText(v);
  if (!needle) return false;
  if (hay.text.includes(needle)) return true;
  // Multi-part answers ("Acme LLC; Beta Co") — every substantive token must appear.
  const tokens = needle.split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  const found = tokens.filter((t) => hay.text.includes(t)).length;
  return found / tokens.length >= 0.85;
};

export function isGrounded(spec: FieldSpec, value: string | number, hay: Haystack): boolean {
  switch (spec.kind) {
    case "money":
    case "number":
    case "year":
      return typeof value === "number" && numberGrounded(value, hay);
    case "taxId":
      return hay.digits.includes(String(value).replace(/\D/g, ""));
    case "date":
      return datesIn(String(value)).some((d) => hay.text.includes(d));
    case "text":
      return textGrounded(String(value), hay);
  }
}

/** Null every value not found in the document. Returns the cleaned fields and the ids that were dropped. */
export function groundFields(
  specs: readonly FieldSpec[],
  fields: ExtractedFields,
  sourceText: string,
): { fields: ExtractedFields; ungrounded: string[] } {
  const hay = buildHaystack(sourceText);
  const out: ExtractedFields = { ...fields };
  const ungrounded: string[] = [];
  for (const spec of specs) {
    const v = out[spec.id];
    if (v == null) continue;
    if (!isGrounded(spec, v, hay)) {
      out[spec.id] = null;
      ungrounded.push(spec.id);
    }
  }
  return { fields: out, ungrounded };
}
