import { describe, expect, it } from "vitest";
import { isEncrypted } from "@/lib/crypto";
import { assertNoTaxIds, decryptFromStorage, encryptForStorage, findTaxIdLike, maskTaxId, outboundFields } from "./mask";

describe("tax id masking", () => {
  it("masks to last four", () => {
    expect(maskTaxId("123-45-6789")).toBe("•••-••-6789");
    expect(maskTaxId("12")).toBe("•••");
  });

  it("encrypts at rest and round-trips", () => {
    const stored = encryptForStorage("tax_return", { taxId: "123456789", taxpayerName: "A" });
    expect(isEncrypted(stored.taxId)).toBe(true);
    expect(stored.taxpayerName).toBe("A");
    expect(encryptForStorage("tax_return", stored).taxId).toBe(stored.taxId); // no double encryption
    expect(decryptFromStorage("tax_return", stored).taxId).toBe("123456789");
  });

  it("outbound view never carries the full id, from plaintext or ciphertext", () => {
    expect(outboundFields("tax_return", { taxId: "123456789" }).taxId).toBe("•••-••-6789");
    const stored = encryptForStorage("tax_return", { taxId: "123456789" });
    expect(outboundFields("tax_return", stored).taxId).toBe("•••-••-••••");
    expect(outboundFields("tax_return", { taxId: null }).taxId).toBeNull();
  });

  it("intake has no tax id fields — passthrough", () => {
    expect(outboundFields("intake", { contactName: "A" })).toEqual({ contactName: "A" });
  });
});

describe("outbound PII gate", () => {
  it.each(["123-45-6789", "12-3456789", "id 123456789 here"])("flags %s", (s) => expect(findTaxIdLike(s)).not.toBeNull());

  it.each(["$1,234,567", "2026-03-31", "555-123-4567", "1234567890", "120500.00", "•••-••-6789"])("ignores %s", (s) =>
    expect(findTaxIdLike(s)).toBeNull(),
  );

  it("throws on a leak in any nested string, ignores numeric amounts", () => {
    expect(() => assertNoTaxIds({ fields: { revenue: 123456789 }, list: ["ok"] })).not.toThrow();
    expect(() => assertNoTaxIds({ fields: { note: "EIN 12-3456789" } })).toThrow(/unmasked/);
    expect(() => assertNoTaxIds([{ a: ["123-45-6789"] }])).toThrow();
  });
});
