import { describe, expect, it } from "vitest";
import { runChecks, scoreConfidence } from "./checks";
import { FIELD_SPECS } from "./schemas";

const blank = (t: keyof typeof FIELD_SPECS) =>
  Object.fromEntries(FIELD_SPECS[t].map((s) => [s.id, null])) as Record<string, string | number | null>;

const byId = (r: ReturnType<typeof runChecks>) => Object.fromEntries(r.map((c) => [c.id, c.status]));

describe("financial statement checks", () => {
  it("passes a consistent P&L and balance sheet", () => {
    const f = { ...blank("financial_statement"), revenue: 1000, cogs: 400, grossProfit: 600, operatingExpenses: 350, netIncome: 250, totalAssets: 900, totalLiabilities: 400, totalEquity: 500, periodStart: "2026-01-01", periodEnd: "2026-03-31" };
    expect(byId(runChecks("financial_statement", f))).toEqual({ gross_profit: "pass", net_income: "pass", balance_sheet: "pass", period_order: "pass" });
  });

  it("fails a misread column and a reversed period", () => {
    const f = { ...blank("financial_statement"), revenue: 1000, cogs: 400, grossProfit: 900, periodStart: "2026-03-31", periodEnd: "2026-01-01" };
    const r = byId(runChecks("financial_statement", f));
    expect(r.gross_profit).toBe("fail");
    expect(r.period_order).toBe("fail");
    expect(r.net_income).toBe("skip");
  });

  it("tolerates rounding", () => {
    const f = { ...blank("financial_statement"), revenue: 100000, cogs: 40000, grossProfit: 60400 };
    expect(byId(runChecks("financial_statement", f)).gross_profit).toBe("pass");
  });

  it("skips period check on unparseable dates", () => {
    const f = { ...blank("financial_statement"), periodStart: "soon", periodEnd: "2026-01-01" };
    expect(byId(runChecks("financial_statement", f)).period_order).toBe("skip");
  });
});

describe("tax return checks", () => {
  it("passes a plausible return", () => {
    const f = { ...blank("tax_return"), taxYear: 2025, grossIncome: 100000, taxableIncome: 80000, totalTax: 12000, refundAmount: 500 };
    expect(byId(runChecks("tax_return", f))).toEqual({ taxable_le_gross: "pass", tax_le_taxable: "pass", refund_xor_owed: "pass", year_plausible: "pass" });
  });

  it("fails impossible combinations", () => {
    const f = { ...blank("tax_return"), taxYear: 2099, grossIncome: 1000, taxableIncome: 5000, totalTax: 9000, refundAmount: 10, amountOwed: 10 };
    expect(Object.values(byId(runChecks("tax_return", f)))).toEqual(["fail", "fail", "fail", "fail"]);
  });

  it("no checks for intake", () => {
    expect(runChecks("intake", blank("intake"))).toEqual([]);
  });
});

describe("scoreConfidence", () => {
  const full = { ...blank("tax_return"), returnType: "1040", taxYear: 2025, taxpayerName: "A", grossIncome: 10, taxableIncome: 5, totalTax: 1 };
  const pass = [{ id: "a", status: "pass" as const, detail: "" }];

  it("complete, grounded, checks passing → 1", () => {
    expect(scoreConfidence({ type: "tax_return", fields: full, ungrounded: [], checks: pass, usedVision: false })).toBe(1);
  });

  it("drops with missing fields, ungrounded values and failures", () => {
    const s = scoreConfidence({ type: "tax_return", fields: { ...full, totalTax: null }, ungrounded: ["totalTax"], checks: [{ id: "a", status: "fail", detail: "" }], usedVision: false });
    expect(s).toBeLessThan(0.75);
  });

  it("vision caps grounding; no checks moves the weight to coverage", () => {
    expect(scoreConfidence({ type: "intake", fields: blank("intake"), ungrounded: [], checks: [], usedVision: true })).toBe(0.15);
    expect(scoreConfidence({ type: "intake", fields: blank("intake"), ungrounded: [], checks: [], usedVision: false })).toBe(0);
  });
});
