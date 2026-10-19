import type { ExtractableDocType, ExtractedFields } from "./schemas";
import { FIELD_SPECS } from "./schemas";

/**
 * Deterministic cross-checks over the extracted numbers. These — not the
 * model's opinion of itself — feed the confidence score, because an 8B local
 * model will confidently misread a column. A failed check never blocks the
 * pipeline; it lowers confidence and is shown to the reviewer.
 */

export type CheckResult = { id: string; status: "pass" | "fail" | "skip"; detail: string };

const num = (f: ExtractedFields, k: string): number | null => (typeof f[k] === "number" ? (f[k] as number) : null);

/** Equal within 1% or 1 unit — statements round. */
const approx = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);

function rule(
  id: string,
  inputs: (number | null)[],
  test: (...v: number[]) => boolean,
  describe: (...v: number[]) => string,
): CheckResult {
  if (inputs.some((v) => v === null)) return { id, status: "skip", detail: "not enough values" };
  const v = inputs as number[];
  return { id, status: test(...v) ? "pass" : "fail", detail: describe(...v) };
}

export function runChecks(type: ExtractableDocType, f: ExtractedFields): CheckResult[] {
  if (type === "financial_statement") {
    return [
      rule("gross_profit", [num(f, "revenue"), num(f, "cogs"), num(f, "grossProfit")],
        (r, c, g) => approx(r - c, g), (r, c, g) => `revenue − COGS = ${r - c}; stated gross profit ${g}`),
      rule("net_income", [num(f, "grossProfit"), num(f, "operatingExpenses"), num(f, "netIncome")],
        (g, o, n) => approx(g - o, n), (g, o, n) => `gross profit − opex = ${g - o}; stated net income ${n} (other income/expense can explain a gap)`),
      rule("balance_sheet", [num(f, "totalAssets"), num(f, "totalLiabilities"), num(f, "totalEquity")],
        (a, l, e) => approx(l + e, a), (a, l, e) => `liabilities + equity = ${l + e}; stated assets ${a}`),
      rule("period_order", [toTime(f.periodStart), toTime(f.periodEnd)],
        (s, e) => s <= e, () => `period ${f.periodStart} → ${f.periodEnd}`),
    ];
  }
  if (type === "tax_return") {
    return [
      rule("taxable_le_gross", [num(f, "taxableIncome"), num(f, "grossIncome")],
        (t, g) => t <= g + 1, (t, g) => `taxable ${t} vs gross ${g}`),
      rule("tax_le_taxable", [num(f, "totalTax"), num(f, "taxableIncome")],
        (t, ti) => t <= ti + 1, (t, ti) => `tax ${t} vs taxable ${ti}`),
      rule("refund_xor_owed", [num(f, "refundAmount") ?? 0, num(f, "amountOwed") ?? 0],
        (r, o) => !(r > 0 && o > 0), (r, o) => `refund ${r}, owed ${o}`),
      rule("year_plausible", [num(f, "taxYear")],
        (y) => y >= 2000 && y <= new Date().getFullYear(), (y) => `tax year ${y}`),
    ];
  }
  return [];
}

function toTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Confidence in [0,1]:
 *   0.5 × required-field coverage
 * + 0.3 × share of returned values that survived grounding (vision: fixed 0.5 — unverifiable)
 * + 0.2 × check pass rate (weight moves to coverage when no check could run)
 */
export function scoreConfidence(input: {
  type: ExtractableDocType;
  fields: ExtractedFields;
  ungrounded: readonly string[];
  checks: readonly CheckResult[];
  usedVision: boolean;
}): number {
  const required = FIELD_SPECS[input.type].filter((s) => s.required);
  const coverage = required.length ? required.filter((s) => input.fields[s.id] != null).length / required.length : 1;

  const kept = Object.values(input.fields).filter((v) => v != null).length;
  const returned = kept + input.ungrounded.length;
  const grounding = input.usedVision ? 0.5 : returned === 0 ? 0 : kept / returned;

  const ran = input.checks.filter((c) => c.status !== "skip");
  const checkScore = ran.length ? ran.filter((c) => c.status === "pass").length / ran.length : null;

  const score = checkScore === null ? 0.7 * coverage + 0.3 * grounding : 0.5 * coverage + 0.3 * grounding + 0.2 * checkScore;
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}
