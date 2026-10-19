import crypto from "node:crypto";

/**
 * Field-level encryption for sensitive values (SSN/EIN).
 * AES-256-GCM, format: enc:v1:<iv hex>:<tag hex>:<ciphertext base64>
 * Key: FIELD_ENCRYPTION_KEY, 64 hex chars (32 bytes).
 */
const PREFIX = "enc:v1:";

function key(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("FIELD_ENCRYPTION_KEY must be 64 hex characters. Run `npm run setup:env`.");
  }
  return Buffer.from(hex, "hex");
}

export const isEncrypted = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIX);

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("base64")}`;
}

export function decrypt(value: string): string {
  if (!isEncrypted(value)) return value;
  const [ivHex, tagHex, ctB64] = value.slice(PREFIX.length).split(":");
  if (!ivHex || !tagHex || !ctB64) return "[unreadable]";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "[unreadable]";
  }
}

/** Domain-separated sub-key, so one configured secret can safely serve several purposes. */
export const deriveKey = (purpose: string): Buffer =>
  crypto.createHmac("sha256", key()).update(`osaka:${purpose}`).digest();
