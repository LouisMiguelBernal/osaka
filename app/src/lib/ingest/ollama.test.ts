import { describe, expect, it, vi } from "vitest";
import { createOllama, LlmError } from "./ollama";

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ message: { content } }), { status, headers: { "content-type": "application/json" } });

const call = { system: "s", user: "u", schema: { type: "object" } };

describe("ollama client", () => {
  it("sends a schema-constrained, non-thinking, deterministic request", async () => {
    const fetchImpl = vi.fn(async () => reply('{"ok":true}'));
    const llm = createOllama({ url: "http://x/", model: "m", fetchImpl });
    expect(await llm.chatJson({ ...call, images: ["AAA"] })).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/api/chat");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "m", stream: false, think: false, format: { type: "object" }, options: { temperature: 0, seed: 42 } });
    expect(body.messages[1].images).toEqual(["AAA"]);
  });

  it("retries malformed JSON, then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply("not json")).mockResolvedValueOnce(reply('{"a":1}'));
    expect(await createOllama({ fetchImpl }).chatJson(call)).toEqual({ a: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget", async () => {
    const fetchImpl = vi.fn(async () => reply("nope"));
    await expect(createOllama({ fetchImpl, retries: 1 }).chatJson(call)).rejects.toThrow(/malformed/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors; retries server errors", async () => {
    const f4 = vi.fn(async () => reply("{}", 404));
    await expect(createOllama({ fetchImpl: f4 }).chatJson(call)).rejects.toMatchObject({ retryable: false });
    expect(f4).toHaveBeenCalledTimes(1);
    const f5 = vi.fn(async () => reply("{}", 503));
    await expect(createOllama({ fetchImpl: f5, retries: 2 }).chatJson(call)).rejects.toBeInstanceOf(LlmError);
    expect(f5).toHaveBeenCalledTimes(3);
  });

  it("reports unreachable and timed-out servers", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(createOllama({ fetchImpl: down, retries: 0, url: "http://h" }).chatJson(call)).rejects.toThrow(/unreachable at http:\/\/h/);
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    await expect(createOllama({ fetchImpl: slow as unknown as typeof fetch, retries: 0, timeoutMs: 20 }).chatJson(call)).rejects.toThrow(/timed out/);
  });

  it("serialises concurrent calls", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return reply("{}");
    });
    const llm = createOllama({ fetchImpl });
    await Promise.all([llm.chatJson(call), llm.chatJson(call), llm.chatJson(call)]);
    expect(peak).toBe(1);
  });

  it("resolves the model digest, null on failure", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "m", digest: "abc" }] })));
    expect(await createOllama({ model: "m", fetchImpl: ok }).digest()).toBe("abc");
    expect(await createOllama({ model: "zz", fetchImpl: ok }).digest()).toBeNull();
    expect(await createOllama({ fetchImpl: vi.fn(async () => new Response("", { status: 500 })) }).digest()).toBeNull();
    expect(await createOllama({ fetchImpl: vi.fn(async () => { throw new Error("x"); }) }).digest()).toBeNull();
  });
});
