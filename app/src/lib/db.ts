import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/** One pool per process, reused across Next.js hot reloads in development. */
const globalForDb = globalThis as unknown as { osakaPool?: Pool };

function pool(): Pool {
  if (!globalForDb.osakaPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. Run `npm run setup:env` first.");
    globalForDb.osakaPool = new Pool({ connectionString: url, max: 8, idleTimeoutMillis: 60_000 });
    // An idle client killed by the server must not crash the process.
    globalForDb.osakaPool.on("error", (err) => console.error("[db] idle client error:", err.message));
  }
  return globalForDb.osakaPool;
}

export const db = drizzle({ client: pool(), schema });
