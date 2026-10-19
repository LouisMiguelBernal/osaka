import { describe, expect, it } from "vitest";
import {
  coerceField,
  FIELD_SPECS,
  isDocType,
  missingRequired,
  ollamaSchema,
  parseAmount,
  parseDate,
  validateExtraction,
} from "./schemas";

describe("parseAmount", () => {
  it.each([
    ["$1,234.50", 1234.5],
    ["(1,234)", -1234],
    ["-500", -500],
    ["500-", -500],
    ["40k", 40000],
    ["1.2M", 1200000],
    ["USD 2,000", 2000],
    ["₱15,000.00", 15000],
    [42, 42],
  ])("%s → %s", (raw, n) => expect(parseAmount(raw)).toBe(n));

  it.each([["about 40k a month"], [""], ["n/a"], [Number.NaN], [null], [{}]])("%s → null", (raw) =>
    expect(parseAmount(raw)).toBeNull(),
  );
});

describe("parseDate", () => {
  it.each([
    ["2026-03-31", "2026-03-31"],
    ["3/31/2026", "2026-03-31"],
    ["March 31, 2026", "2026-03-31"],
    ["Mar 31 2026", "2026-03-31"],
    ["31 March 2026", "2026-03-31"],
  ])("%s → %s", (raw, iso) => expect(parseDate(raw)).toBe(iso));

  it.each([["2026-02-30"], ["Q1 2026"], ["13/01/2026"], [20260331]])("%s → null", (raw) => expect(parseDate(raw)).toBeNull());
});

describe("coerceField", () => {
  const spec = (kind: Parameters<typeof coerceField>[0]["kind"]) => ({ id: "x", label: "x", kind });
  it("normalises each kind", () => {
    expect(coerceField(spec("year"), "2025")).toBe(2025);
    expect(coerceField(spec("year"), 1850)).toBeNull();
    expect(coerceField(spec("taxId"), "12-3456789")).toBe("123456789");
    expect(coerceField(spec("taxId"), "XXX-XX-1234")).toBeNull();
    expect(coerceField(spec("text"), "  $40k/month ")).toBe("$40k/month");
    expect(coerceField(spec("text"), 12)).toBe("12");
    expect(coerceField(spec("text"), "N/A")).toBeNull();
    expect(coerceField(spec("text"), "   ")).toBeNull();
    expect(coerceField(spec("number"), "3")).toBe(3);
    expect(coerceField(spec("date"), "1/2/2026")).toBe("2026-01-02");
    expect(coerceField(spec("money"), undefined)).toBeNull();
  });
});

describe("validateExtraction", () => {
  it("keeps exactly the spec keys, drops unknown keys, coerces values", () => {
    const out = validateExtraction("financial_statement", { revenue: "$1,000", injected: "x", netIncome: "(50)" });
    expect(Object.keys(out).sort()).toEqual(FIELD_SPECS.financial_statement.map((s) => s.id).sort());
    expect(out.revenue).toBe(1000);
    expect(out.netIncome).toBe(-50);
    expect(out).not.toHaveProperty("injected");
  });

  it("survives non-object model output", () => {
    const out = validateExtraction("tax_return", "garbage");
    expect(Object.values(out).every((v) => v === null)).toBe(true);
  });

  it("lists missing required fields", () => {
    const out = validateExtraction("tax_return", { returnType: "1040", taxYear: 2025 });
    expect(missingRequired("tax_return", out)).toEqual(["taxpayerName", "grossIncome", "taxableIncome", "totalTax"]);
  });
});

describe("ollamaSchema", () => {
  it("requires every field and types numerics as number|null", () => {
    const s = ollamaSchema("tax_return") as { required: string[]; properties: Record<string, { type: string[] }> };
    expect(s.required).toHaveLength(FIELD_SPECS.tax_return.length);
    expect(s.properties.grossIncome.type).toEqual(["number", "null"]);
    expect(s.properties.taxpayerName.type).toEqual(["string", "null"]);
  });
});

describe("field contracts", () => {
  it("ids are unique per document type", () => {
    for (const specs of Object.values(FIELD_SPECS)) expect(new Set(specs.map((f) => f.id)).size).toBe(specs.length);
  });

  it("only tax returns carry a tax id field", () => {
    expect(FIELD_SPECS.intake.some((f) => f.kind === "taxId")).toBe(false);
    expect(FIELD_SPECS.tax_return.some((f) => f.kind === "taxId")).toBe(true);
  });

  it("doc type guard", () => {
    expect(isDocType("intake")).toBe(true);
    expect(isDocType("invoice")).toBe(false);
  });
});
