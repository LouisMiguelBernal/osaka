import { describe, expect, it } from "vitest";
import { decideSender, isValidEmail, normaliseEmail, parseAllowlist, parseSenderAuth } from "./policy";

const base = { email: "ana@acme.com", auth: "pass" as const, knownClient: false, allowlist: [] as string[], requireAuth: true };

describe("sender policy", () => {
  it("accepts known clients and allowlisted domains/addresses", () => {
    expect(decideSender({ ...base, knownClient: true })).toEqual({ accept: true, reason: "known_client" });
    expect(decideSender({ ...base, allowlist: ["acme.com"] })).toEqual({ accept: true, reason: "allowlisted" });
    expect(decideSender({ ...base, allowlist: ["ana@acme.com"] })).toEqual({ accept: true, reason: "allowlisted" });
  });

  it("quarantines strangers, spoofed senders and garbage addresses", () => {
    expect(decideSender(base).accept).toBe(false);
    expect(decideSender({ ...base, knownClient: true, auth: "fail" })).toMatchObject({ accept: false, reason: expect.stringMatching(/fail/) });
    expect(decideSender({ ...base, knownClient: true, auth: "none" }).accept).toBe(false);
    expect(decideSender({ ...base, email: "not-an-email", knownClient: true }).accept).toBe(false);
    expect(decideSender({ ...base, allowlist: ["cme.com"] }).accept).toBe(false);
  });

  it("auth requirement can be relaxed for local testing", () => {
    expect(decideSender({ ...base, auth: "none", knownClient: true, requireAuth: false }).accept).toBe(true);
  });

  it("parsers", () => {
    expect(normaliseEmail("Ana Cruz <Ana@Acme.COM>")).toBe("ana@acme.com");
    expect(normaliseEmail(" bob@x.io ")).toBe("bob@x.io");
    expect(parseAllowlist(" @Acme.com, bob@x.io ,,")).toEqual(["acme.com", "bob@x.io"]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseSenderAuth("pass")).toBe("pass");
    expect(parseSenderAuth("PASS?")).toBe("none");
    expect(isValidEmail("a@b.co")).toBe(true);
  });
});
