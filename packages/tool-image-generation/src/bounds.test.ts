/**
 * 0.7.1 (C168) — ImageGenerate is bounded by the turn's signal, by a
 * deadline of its own, and by the bytes it reads.
 *
 * It used to call fetch with no signal and read both bodies whole, so an
 * aborted turn (Ctrl-C, turn_timeout_ms, deadline_ms) stayed blocked on a
 * provider that stalled, and a provider or proxy that sent a huge body had
 * all of it buffered. None of these tests touch the network: every fetch is
 * injected, and it hangs, streams or answers in-process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ImageGenerationError, imageGenerate, registerImageGenerationConfig } from "./index";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env["OPENAI_API_KEY"] = "sk-test";
  registerImageGenerationConfig({});
});

afterEach(() => {
  process.env = savedEnv;
  registerImageGenerationConfig({});
});

type Ctx = Parameters<typeof imageGenerate.execute>[1];

/** A fetch that never answers but, like the real one, rejects when its signal aborts. */
function hangingFetch(seen: { signal?: AbortSignal | null }): typeof globalThis.fetch {
  return ((_url: unknown, init?: RequestInit) => {
    seen.signal = init?.signal ?? null;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
        once: true,
      });
    });
  }) as unknown as typeof globalThis.fetch;
}

/** A response body streamed in 1 MiB chunks up to `totalMiB`, counting what was pulled. */
function streamingFetch(status: number, totalMiB: number, counter: { pulled: number }) {
  const CHUNK = 1 << 20;
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (counter.pulled >= totalMiB * CHUNK) {
            c.close();
            return;
          }
          counter.pulled += CHUNK;
          c.enqueue(new Uint8Array(CHUNK).fill(65));
        },
      }),
      { status },
    )) as unknown as typeof globalThis.fetch;
}

/** Settle within `ms` or report "pending"; never races real I/O. */
function settle(p: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    p.then(
      () => "resolved",
      (e: Error) =>
        `rejected: ${e instanceof ImageGenerationError ? "" : "(not ours) "}${e.message}`,
    ),
    Bun.sleep(ms).then(() => "pending"),
  ]);
}

describe("ImageGenerate is bounded", () => {
  test("the turn's signal reaches fetch, and aborting it ends the call as cancelled", async () => {
    const seen: { signal?: AbortSignal | null } = {};
    const turn = new AbortController();
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      signal: turn.signal,
      toolConfig: { provider: "openai", fetch: hangingFetch(seen) },
    } as unknown as Ctx);
    await Bun.sleep(5);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    turn.abort(new Error("turn aborted"));
    expect(await settle(p, 2000)).toBe("rejected: OpenAI image-generation request was cancelled");
  });

  test("a turn already aborted never waits on the provider", async () => {
    const turn = new AbortController();
    turn.abort();
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      signal: turn.signal,
      toolConfig: { provider: "openai", fetch: hangingFetch({}) },
    } as unknown as Ctx);
    expect(await settle(p, 2000)).toBe("rejected: OpenAI image-generation request was cancelled");
  });

  test("a provider that never answers times out at timeoutMs", async () => {
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      toolConfig: { provider: "openai", fetch: hangingFetch({}), timeoutMs: 50 },
    } as unknown as Ctx);
    expect(await settle(p, 5000)).toBe(
      "rejected: OpenAI image-generation request timed out after 50 ms",
    );
  });

  test("a success body past maxResponseBytes is refused, and the rest is never read", async () => {
    const counter = { pulled: 0 };
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      toolConfig: {
        provider: "openai",
        fetch: streamingFetch(200, 8, counter),
        maxResponseBytes: 1 << 20,
      },
    } as unknown as Ctx);
    expect(await settle(p, 5000)).toMatch(/^rejected: .*exceeded 1048576 bytes/);
    expect(counter.pulled).toBeLessThanOrEqual(3 << 20);
  });

  test("an error body is read only as far as the message shows", async () => {
    const counter = { pulled: 0 };
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      toolConfig: { provider: "openai", fetch: streamingFetch(500, 8, counter) },
    } as unknown as Ctx);
    const outcome = await settle(p, 5000);
    expect(outcome).toMatch(/^rejected: OpenAI image-generation request failed \(500/);
    expect(outcome).toContain("… (truncated)");
    expect(counter.pulled).toBeLessThanOrEqual(3 << 20);
  });

  test("a body that stalls after its headers ends at the deadline", async () => {
    const stalled = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"data":'));
            // …and nothing more, ever.
          },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      toolConfig: { provider: "openai", fetch: stalled, timeoutMs: 50 },
    } as unknown as Ctx);
    expect(await settle(p, 5000)).toBe(
      "rejected: OpenAI image-generation request timed out after 50 ms",
    );
  });

  test("the caller's AbortSignal.timeout stays armed after a call that listened to it", async () => {
    // On Bun, removing the last listener from an AbortSignal.timeout() signal
    // cancels its timer; the turn's deadline must survive a finished call.
    const deadline = AbortSignal.timeout(100);
    const ok = (async () =>
      Response.json({ data: [{ url: "https://img.example/1.png" }] })) as typeof fetch;
    const out = await imageGenerate.execute({ prompt: "a cat" }, {
      signal: deadline,
      toolConfig: { provider: "openai", fetch: ok },
    } as unknown as Ctx);
    expect(out).toContain("https://img.example/1.png");
    for (let waited = 0; !deadline.aborted && waited < 5000; waited += 25) await Bun.sleep(25);
    expect(deadline.aborted).toBe(true);
  });

  test("a limit that is not a positive whole number is refused, at boot and per call", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "60000"]) {
      expect(() => registerImageGenerationConfig({ timeoutMs: bad as number })).toThrow(
        "tool_config.imageGenerate.timeoutMs must be a positive whole number of milliseconds",
      );
      expect(() => registerImageGenerationConfig({ maxResponseBytes: bad as number })).toThrow(
        "tool_config.imageGenerate.maxResponseBytes must be a positive whole number of bytes",
      );
    }
    const p = imageGenerate.execute({ prompt: "a cat" }, {
      toolConfig: { provider: "openai", fetch: hangingFetch({}), timeoutMs: 0 },
    } as unknown as Ctx);
    expect(await settle(p, 2000)).toMatch(/^rejected: tool_config\.imageGenerate\.timeoutMs/);
  });
});
