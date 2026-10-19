import { describe, expect, it, vi } from "vitest";
import type { Llm, LlmCall } from "./ollama";
import { LlmError } from "./ollama";
import type { PdfReader } from "./pdf";
import { PdfRejected } from "./pdf";
import { chunkPages, mergeChunks, PipelineError, runPipeline } from "./pipeline";
import { CLASSIFY_SYSTEM } from "./prompts";

const PNL = [
  "ACME Trading LLC\nProfit and Loss\nJanuary 1, 2026 - March 31, 2026",
  "Total Revenue 120,500.00\nCost of Goods Sold 40,500.00\nGross Profit 80,000.00\nTotal Operating Expenses 50,000.00\nNet Income 30,000.00",
];

const reader = (pages: string[], scanned = false): PdfReader => ({
  read: vi.fn(async () => ({ pageCount: pages.length, pages, scanned })),
  renderPages: vi.fn(async (_d: Uint8Array, n: number) => Array.from({ length: n }, (_, i) => `img${i}`)),
});

/** Scripted model: classify answer, then one extraction answer per call. */
const llm = (docType: string, extractions: Record<string, unknown>[]): Llm & { calls: LlmCall[] } => {
  const calls: LlmCall[] = [];
  let i = 0;
  return {
    model: "stub",
    calls,
    digest: async () => "sha256:stub",
    chatJson: async (call) => {
      calls.push(call);
      if (call.system === CLASSIFY_SYSTEM) return { docType, reason: "title says Profit and Loss" };
      return extractions[i++] ?? {};
    },
  };
};

const pdf = new Uint8Array([1]);

describe("runPipeline", () => {
  it("extracts, grounds, checks and scores a text P&L", async () => {
    const model = llm("financial_statement", [
      {
        statementType: "profit_and_loss", entityName: "ACME Trading LLC", periodStart: "2026-01-01", periodEnd: "2026-03-31",
        revenue: 120500, cogs: 40500, grossProfit: 80000, operatingExpenses: 50000, netIncome: 30000,
        totalAssets: 999999, // invented — not in the document
      },
    ]);
    const r = await runPipeline(pdf, { llm: model, reader: reader(PNL) });
    expect(r.docType).toBe("financial_statement");
    expect(r.fields.revenue).toBe(120500);
    expect(r.fields.totalAssets).toBeNull();
    expect(r.ungrounded).toEqual(["totalAssets"]);
    expect(r.missingFields).toEqual([]);
    expect(r.checks.find((c) => c.id === "gross_profit")?.status).toBe("pass");
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.usedVision).toBe(false);
    // The document only ever travels inside <document> tags.
    expect(model.calls[1].user).toMatch(/^<document>[\s\S]*<\/document>$/);
  });

  it("stops after classification for unrelated documents", async () => {
    const model = llm("other", []);
    const r = await runPipeline(pdf, { llm: model, reader: reader(["Invoice #12"]) });
    expect(r).toMatchObject({ docType: "other", fields: {}, confidence: 0 });
    expect(model.calls).toHaveLength(1);
  });

  it("treats an unknown classification as other", async () => {
    const r = await runPipeline(pdf, { llm: llm("recipe", []), reader: reader(["x"]) });
    expect(r.docType).toBe("other");
  });

  it("uses page images for scanned PDFs and flags them as unverified", async () => {
    const pages = Array.from({ length: 12 }, () => "");
    const model = llm("tax_return", [{ returnType: "1040", taxYear: 2025 }, { totalTax: 5000 }, {}, {}]);
    const rd = reader(pages, true);
    const r = await runPipeline(pdf, { llm: model, reader: rd });
    expect(rd.renderPages).toHaveBeenCalledWith(pdf, 12);
    expect(model.calls[0].images).toHaveLength(2);
    expect(model.calls.slice(1).map((c) => c.images?.length)).toEqual([3, 3, 3, 3]);
    expect(r.usedVision).toBe(true);
    expect(r.fields).toMatchObject({ returnType: "1040", taxYear: 2025, totalTax: 5000 });
    expect(r.ungrounded).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/first 12 of 12|could not be verified/);
  });

  it("warns when only part of a long scan is read", async () => {
    const rd = reader(Array.from({ length: 15 }, () => ""), true);
    rd.renderPages = vi.fn(async () => Array.from({ length: 10 }, () => "img"));
    const r = await runPipeline(pdf, { llm: llm("other", []), reader: rd });
    expect(r.warnings[0]).toMatch(/first 10 of 15/);
  });

  it("reads long documents in chunks and reports cross-page conflicts", async () => {
    const pages = ["A".repeat(15_000) + " 2025", "B".repeat(15_000) + " 2024"];
    const model = llm("tax_return", [{ taxYear: 2025 }, { taxYear: 2024 }]);
    const r = await runPipeline(pdf, { llm: model, reader: reader(pages) });
    expect(model.calls).toHaveLength(3);
    expect(model.calls[1].user).toMatch(/^Pages 1–1 of 2/);
    expect(r.fields.taxYear).toBe(2025);
    expect(r.warnings.join(" ")).toMatch(/taxYear/);
  });

  it("maps a rejected PDF to a non-retryable validate_file failure", async () => {
    const rd = reader([]);
    rd.read = vi.fn(async () => { throw new PdfRejected("encrypted", "locked"); });
    await expect(runPipeline(pdf, { llm: llm("x", []), reader: rd })).rejects.toMatchObject({ stage: "validate_file", retryable: false, message: "locked" });
    rd.read = vi.fn(async () => { throw new Error("boom"); });
    await expect(runPipeline(pdf, { llm: llm("x", []), reader: rd })).rejects.toBeInstanceOf(PipelineError);
  });

  it("maps model outages to retryable failures at the right stage", async () => {
    const down: Llm = { model: "x", digest: async () => null, chatJson: async () => { throw new LlmError("Ollama unreachable", true); } };
    await expect(runPipeline(pdf, { llm: down, reader: reader(PNL) })).rejects.toMatchObject({ stage: "classify", retryable: true });

    let n = 0;
    const flaky: Llm = { model: "x", digest: async () => null, chatJson: async () => { if (n++ === 0) return { docType: "intake", reason: "" }; throw new Error("odd"); } };
    await expect(runPipeline(pdf, { llm: flaky, reader: reader(PNL) })).rejects.toMatchObject({ stage: "extract", retryable: true });
  });
});

describe("chunkPages / mergeChunks", () => {
  it("packs pages greedily and caps a giant page", () => {
    const c = chunkPages(["a".repeat(10), "b".repeat(10), "c".repeat(100)], 60);
    expect(c.map((x) => [x.from, x.to])).toEqual([[1, 2], [3, 3]]);
    expect(chunkPages(["x".repeat(500)], 100)[0].text.length).toBeLessThan(130);
    expect(chunkPages([])).toEqual([]);
  });

  it("first non-null wins", () => {
    const { fields, conflicts } = mergeChunks("tax_return", [{ taxYear: null, totalTax: 5 }, { taxYear: 2025, totalTax: 5 }]);
    expect(fields.taxYear).toBe(2025);
    expect(fields.totalTax).toBe(5);
    expect(conflicts).toEqual([]);
  });
});
