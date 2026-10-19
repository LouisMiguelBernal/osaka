// Creates app/.env.local and n8n/.env from their templates with freshly generated secrets.
// Never overwrites an existing file, never prints a secret.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const n8nDir = path.resolve(appDir, "..", "n8n");
const appEnv = path.join(appDir, ".env.local");
const n8nEnv = path.join(n8nDir, ".env");

if (fs.existsSync(appEnv) || fs.existsSync(n8nEnv)) {
  console.log("Env files already exist, left untouched. Delete both to regenerate (encrypted data needs the old keys).");
  process.exit(0);
}

const hex = () => crypto.randomBytes(32).toString("hex");
const dbPassword = crypto.randomBytes(18).toString("base64url");
const ingestSecret = hex();
const dbPort = process.env.OSAKA_DB_PORT || "55432";
const fill = (file, values) =>
  fs.readFileSync(file, "utf8").replace(/^([A-Z0-9_]+)=(.*)$/gm, (line, k) => (k in values ? `${k}=${values[k]}` : line));

fs.writeFileSync(
  appEnv,
  fill(path.join(appDir, "config", "env.template"), {
    DATABASE_URL: `postgres://postgres:${dbPassword}@127.0.0.1:${dbPort}/osaka`,
    FIELD_ENCRYPTION_KEY: hex(),
    OSAKA_INGEST_SECRET: ingestSecret,
  }),
  { mode: 0o600 },
);
fs.writeFileSync(
  n8nEnv,
  fill(path.join(n8nDir, "env.template"), { OSAKA_DB_PASSWORD: dbPassword, N8N_ENCRYPTION_KEY: hex(), OSAKA_INGEST_SECRET: ingestSecret }),
  { mode: 0o600 },
);
console.log("Wrote app/.env.local and n8n/.env. Back both up somewhere safe: they hold the encryption keys.");
