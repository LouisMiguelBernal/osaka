/**
 * Sender policy — decided BEFORE any model call. Anyone can email the inbox, so
 * an unknown or unauthenticated sender's attachment is quarantined: stored for
 * an operator to release, never processed or attached to a client automatically.
 */

export type SenderAuth = "pass" | "fail" | "none";

export const parseSenderAuth = (v: unknown): SenderAuth => (v === "pass" || v === "fail" ? v : "none");

export type PolicyDecision = { accept: true; reason: "known_client" | "allowlisted" } | { accept: false; reason: string };

export const normaliseEmail = (raw: string): string => {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim().toLowerCase();
};

export const isValidEmail = (e: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(e);

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function decideSender(input: {
  email: string;
  auth: SenderAuth;
  knownClient: boolean;
  allowlist: readonly string[];
  requireAuth: boolean;
}): PolicyDecision {
  if (!isValidEmail(input.email)) return { accept: false, reason: "Sender address is not a valid email." };
  if (input.requireAuth && input.auth !== "pass") {
    return { accept: false, reason: `Sender authentication (SPF/DKIM/DMARC) did not pass: ${input.auth}.` };
  }
  if (input.knownClient) return { accept: true, reason: "known_client" };
  const domain = input.email.split("@")[1];
  if (input.allowlist.some((entry) => entry === input.email || entry === domain)) return { accept: true, reason: "allowlisted" };
  return { accept: false, reason: "Sender is not a known client or on the allowlist." };
}
