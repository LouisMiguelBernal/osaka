import { describe, expect, it } from "vitest";
import { buildHaystack, groundFields, isGrounded, numbersIn } from "./ground";
import { FIELD_SPECS } from "./schemas";

const spec = (kind: "text" | "money" | "date" | "taxId" | "year") => ({ id: "x", label: "x", kind });

describe("numbersIn", () => {
  it("finds amounts in accounting formats", () => {
    expect(numbersIn("Revenue $120,500.00  COGS (40,000)  Margin 66.8%")).toEqual(expect.arrayContaining([120500, 40000, 66.8]));
  });
});

describe("isGrounded", () => {
  const hay = buildHaystack(
    "ACME Trading LLC\nProfit & Loss  January 1, 2026 - 03/31/2026\nTotal Revenue $120,500.00\nEIN 12-3456789\nPricing: $10 per kilo",
  );

  it("numbers must be printed", () => {
    expect(isGrounded(spec("money"), 120500, hay)).toBe(true);
    expect(isGrounded(spec("money"), 999, hay)).toBe(false);
    expect(isGrounded(spec("money"), -120500, hay)).toBe(true);
    expect(isGrounded(spec("money"), "120500" as unknown as number, hay)).toBe(false);
  });

  it("text matches after normalisation, including multi-token answers", () => {
    expect(isGrounded(spec("text"), "Acme Trading LLC", hay)).toBe(true);
    expect(isGrounded(spec("text"), "$10 per kilo", hay)).toBe(true);
    expect(isGrounded(spec("text"), "Globex Corporation", hay)).toBe(false);
    expect(isGrounded(spec("text"), "--", hay)).toBe(false);
    expect(isGrounded(spec("text"), "a b", hay)).toBe(false);
  });

  it("dates match any common printed form", () => {
    expect(isGrounded(spec("date"), "2026-01-01", hay)).toBe(true);
    expect(isGrounded(spec("date"), "2026-03-31", hay)).toBe(true);
    expect(isGrounded(spec("date"), "2026-06-30", hay)).toBe(false);
  });

  it("tax ids match by digits", () => {
    expect(isGrounded(spec("taxId"), "123456789", hay)).toBe(true);
    expect(isGrounded(spec("taxId"), "987654321", hay)).toBe(false);
  });

  it("years", () => {
    expect(isGrounded(spec("year"), 2026, hay)).toBe(true);
    expect(isGrounded(spec("year"), 2019, hay)).toBe(false);
  });
});

describe("groundFields", () => {
  it("nulls invented values and reports them; leaves nulls alone", () => {
    const fields = Object.fromEntries(FIELD_SPECS.financial_statement.map((s) => [s.id, null])) as Record<string, string | number | null>;
    Object.assign(fields, { entityName: "Acme LLC", revenue: 120500, netIncome: 999 });
    const { fields: out, ungrounded } = groundFields(FIELD_SPECS.financial_statement, fields, "Acme LLC revenue 120,500");
    expect(out.entityName).toBe("Acme LLC");
    expect(out.revenue).toBe(120500);
    expect(out.netIncome).toBeNull();
    expect(ungrounded).toEqual(["netIncome"]);
  });
});
