import { describe, expect, it } from "vitest";
import { decrypt, encrypt, isEncrypted } from "./crypto";
import { resolveKey, sanitizeFileName, signedFileUrl, verifyFileUrl } from "./storage";

describe("crypto", () => {
  it("round-trips and produces fresh ciphertext each time", () => {
    const a = encrypt("900123456");
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toBe(encrypt("900123456"));
    expect(decrypt(a)).toBe("900123456");
  });

  it("passes plaintext through and refuses tampered ciphertext", () => {
    expect(decrypt("plain")).toBe("plain");
    expect(decrypt("enc:v1:zz")).toBe("[unreadable]");
    const a = encrypt("x");
    expect(decrypt(a.slice(0, -4) + "AAAA")).toBe("[unreadable]");
  });
});

describe("storage", () => {
  it("sanitizes file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\x\\a<b>.pdf")).toBe("ab.pdf");
    expect(sanitizeFileName("...")).toBe("file.pdf");
    expect(sanitizeFileName("a".repeat(300) + ".pdf")).toHaveLength(200);
  });

  it("never resolves outside the storage root", () => {
    expect(() => resolveKey("../outside.pdf")).toThrow(/escapes/);
    expect(resolveKey("inbox/a.pdf")).toMatch(/inbox[\\/]a\.pdf$/);
  });

  it("signed links expire and cannot be altered", () => {
    const now = 1_800_000_000;
    const q = Object.fromEntries(new URLSearchParams(signedFileUrl("inbox/a.pdf", 60, now).split("?")[1])) as { key: string; exp: string; sig: string };
    expect(verifyFileUrl(q, now)).toBe(true);
    expect(verifyFileUrl(q, now + 61)).toBe(false);
    expect(verifyFileUrl({ ...q, key: "inbox/b.pdf" }, now)).toBe(false);
    expect(verifyFileUrl({ ...q, sig: "nope" }, now)).toBe(false);
  });
});
