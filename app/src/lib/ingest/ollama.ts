/**
 * Minimal Ollama client for schema-constrained extraction with gemma4:e4b.
 *
 * - `think: false` — Gemma 4 thinks by default, which spends tokens and can
 *   leak reasoning ahead of the JSON. Off for extraction.
 * - `format: <json schema>` — decoding is constrained to the schema.
 * - temperature 0 + fixed seed — same input, same output (evals are reproducible).
 * - one request at a time per process (`queue`) — a local 8B model serialises
 *   anyway; parallel requests only thrash VRAM and blow timeouts.
 */

export type LlmCall = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  images?: string[]; // base64 PNG
};

export interface Llm {
  readonly model: string;
  chatJson(call: LlmCall): Promise<unknown>;
  digest(): Promise<string | null>;
}

export class LlmError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "LlmError";
  }
}

let queue: Promise<unknown> = Promise.resolve();
const serialised = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

export function createOllama(opts?: {
  url?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}): Llm {
  const url = (opts?.url ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = opts?.model ?? process.env.OLLAMA_MODEL ?? "gemma4:e4b";
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const retries = opts?.retries ?? 2;
  const doFetch = opts?.fetchImpl ?? fetch;

  async function once(call: LlmCall): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: "15m",
          format: call.schema,
          options: { temperature: 0, seed: 42, num_ctx: 32768 },
          messages: [
            { role: "system", content: call.system },
            { role: "user", content: call.user, ...(call.images?.length ? { images: call.images } : {}) },
          ],
        }),
      });
    } catch (err) {
      throw new LlmError(ctrl.signal.aborted ? `Ollama timed out after ${timeoutMs} ms` : `Ollama unreachable at ${url}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new LlmError(`Ollama HTTP ${res.status}`, res.status >= 500);
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? "";
    try {
      return JSON.parse(content);
    } catch {
      throw new LlmError("Model returned malformed JSON", true);
    }
  }

  return {
    model,
    chatJson: (call) =>
      serialised(async () => {
        let last: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            return await once(call);
          } catch (err) {
            last = err;
            if (!(err instanceof LlmError) || !err.retryable) break;
          }
        }
        throw last;
      }),
    async digest() {
      try {
        const res = await doFetch(`${url}/api/tags`);
        if (!res.ok) return null;
        const { models } = (await res.json()) as { models?: { name: string; digest: string }[] };
        return models?.find((m) => m.name === model)?.digest ?? null;
      } catch {
        return null;
      }
    },
  };
}
