import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deriveKey } from "./crypto";

/**
 * Local-disk document store. Keys are opaque; files are never served from a static path. The
 * dashboard gets short-lived signed links (/api/files) instead.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const root = (): string => path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), "storage"));

/** Basename only, no control or header-breaking characters, never empty. */
export function sanitizeFileName(raw: string): string {
  const base = String(raw ?? "").split(/[/\\]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!clean) return "file.pdf";
  if (clean.length <= 200) return clean;
  const ext = path.extname(clean).slice(0, 10);
  return clean.slice(0, 200 - ext.length) + ext;
}

/** Resolve a key inside the storage root; anything that escapes it is rejected. */
export function resolveKey(key: string): string {
  const base = root();
  const full = path.resolve(base, key);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("Storage key escapes the storage root");
  return full;
}

export async function putFile(key: string, data: Uint8Array): Promise<void> {
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export const getFile = (key: string): Promise<Buffer> => fs.readFile(resolveKey(key));

const sign = (key: string, exp: number): string =>
  crypto.createHmac("sha256", deriveKey("file-links")).update(`${key}\n${exp}`).digest("hex");

export function signedFileUrl(key: string, ttlSeconds = 600, now = Math.floor(Date.now() / 1000)): string {
  const exp = now + ttlSeconds;
  return `/api/files?${new URLSearchParams({ key, exp: String(exp), sig: sign(key, exp) })}`;
}

export function verifyFileUrl(q: { key: string; exp: string; sig: string }, now = Math.floor(Date.now() / 1000)): boolean {
  const exp = Number(q.exp);
  if (!q.key || !Number.isInteger(exp) || exp < now || !/^[0-9a-f]{64}$/.test(q.sig)) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(q.key, exp), "hex"), Buffer.from(q.sig, "hex"));
}
