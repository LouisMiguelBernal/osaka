import { describe, expect, it } from "vitest";
import type { Extraction } from "@/lib/schema";
import { encryptForStorage } from "./mask";
import { buildSummary, formatValue, safeName } from "./present";

const row = (over: Partial<Extraction> = {}): Extraction => ({
  id: "11111111-1111-1111-1111-111111111111",
  documentId: null,
  clientId: "c1",
  source: "email",
  senderEmail: "ana@acme.com",
  subject: "Our 2025 return",
  messageId: "m1",
  threadId: "t1",
  sha256: "a".repeat(64),
  fileName: "2025 return/final.pdf",
  storageKey: "inbox/x/y.pdf",
  senderAuth: "pass",
  classifyReason: "Form 1040",
  warnings: [],
  docType: "tax_return",
  status: "needs_review",
  failedStage: null,
  failedReason: null,
  fields: encryptForStorage("tax_return", { returnType: "1040", taxYear: 2025, taxpayerName: "Ana Cruz", taxId: "123456789", grossIncome: 98765.5 }),
  ungrounded: [],
  missingFields: ["totalTax"],
  confidence: "0.812",
  checks: [],
  pageCount: 2,
  usedVision: false,
  model: "gemma4:e4b",
  modelDigest: null,
  promptVersion: "p",
  schemaVersion: "s",
  durationMs: 1,
  fanout: {},
  reviewedAt: null,
  reviewedBy: null,
  createdAt: new Date("2026-10-18T03:00:00Z"),
  updatedAt: new Date("2026-10-18T03:00:00Z"),
  ...over,
});

describe("buildSummary", () => {
  it("produces a masked, labelled payload with Drive and Sheet targets", () => {
    const s = buildSummary({ row: row(), clientName: "Ana Cruz", senderName: "Ana", duplicate: false, baseUrl: "http://localhost:3030/" });
    expect(s.docTypeLabel).toBe("Tax return");
    expect(s.confidence).toBe(0.812);
    expect(s.fields.find((f) => f.id === "taxId")?.value).toBe("•••-••-••••");
    expect(s.fields.find((f) => f.id === "grossIncome")?.value).toBe("98,765.5");
    expect(s.missingFields).toEqual([{ id: "totalTax", label: "Total tax", value: null }]);
    expect(s.dashboardUrl).toBe("http://localhost:3030/inbox/11111111-1111-1111-1111-111111111111");
    expect(s.drive).toEqual({ folderPath: ["OSAKA", "Ana Cruz", "Tax return"], fileName: "2026-10-18_tax_return_2025 return final.pdf" });
    expect(s.sheet?.tab).toBe("tax_return");
    expect(s.sheet?.row.taxId).toBe("•••-••-••••");
    expect(JSON.stringify(s)).not.toContain("123456789");
  });

  it("quarantined/failed rows carry no Drive/Sheet targets", () => {
    const s = buildSummary({ row: row({ status: "quarantined", docType: null, fields: {}, failedReason: "Unknown sender", clientId: null }), clientName: null, senderName: null, duplicate: false, baseUrl: "http://x" });
    expect(s).toMatchObject({ drive: null, sheet: null, client: null, docTypeLabel: "Not classified", reason: "Unknown sender", fields: [] });
  });

  it("other documents go to Drive but not to a Sheet tab", () => {
    const s = buildSummary({ row: row({ docType: "other", fields: {}, missingFields: [], confidence: null }), clientName: null, senderName: null, duplicate: true, baseUrl: "http://x" });
    expect(s.sheet).toBeNull();
    expect(s.drive?.folderPath).toEqual(["OSAKA", "ana@acme.com", "Other / unrecognised"]);
    expect(s.confidence).toBeNull();
    expect(s.duplicate).toBe(true);
  });

  it("refuses to emit a payload containing a plaintext tax id", () => {
    expect(() => buildSummary({ row: row({ subject: null, fileName: "ssn 123-45-6789.pdf" }), clientName: null, senderName: null, duplicate: false, baseUrl: "http://x" })).toThrow(/unmasked/);
  });
});

describe("helpers", () => {
  it("formatValue / safeName", () => {
    expect(formatValue({ id: "a", label: "a", kind: "money" }, 1234)).toBe("1,234");
    expect(formatValue({ id: "a", label: "a", kind: "text" }, null)).toBeNull();
    expect(safeName('a/b:c*"d')).toBe("a b c d");
    expect(safeName("///")).toBe("unknown");
  });
});
