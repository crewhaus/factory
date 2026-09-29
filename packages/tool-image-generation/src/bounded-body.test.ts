/**
 * ImageGenerate's maxResponseBytes caps the DECODED body (C093).
 *
 * The request did not pass `decompress: false`, so Bun inflated a gzip, br
 * or zstd reply in native code before the capped reader saw a byte, and the
 * cap bounded nothing. The body is now asked for raw (tool-fetch's edge-safe
 * `withRawBody`: this package ships in the cf-worker bundle, so it must not
 * depend on tool-safety) and decoded with its output bounded by the cap.
 *
 * `globalThis.fetch` is replaced by a recorder that answers in-process: it
 * sees exactly the init the tool passed, and a constructed Response is never
 * decoded by the runtime, so it stands for a raw body exactly.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { imageGenerate, registerImageGenerationConfig } from "./index";

type Ctx = Parameters<typeof imageGenerate.execute>[1];

let bomb: Uint8Array;
let savedEnv: NodeJS.ProcessEnv;
const realFetch = globalThis.fetch;
let inits: Array<Record<string, unknown> | undefined> = [];
let answer: () => Response = () => new Response("");

beforeAll(() => {
  bomb = new Uint8Array(gzipSync(new Uint8Array(64 * 1024 * 1024), { level: 9 }));
});

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env["OPENAI_API_KEY"] = "sk-test";
  registerImageGenerationConfig({});
  inits = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    inits.push(init as Record<string, unknown> | undefined);
    return answer();
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  registerImageGenerationConfig({});
});

const gz =
  (body: Uint8Array | string, status = 200): (() => Response) =>
  () =>
    new Response(body, { status, headers: { "content-encoding": "gzip" } });

const run = (maxResponseBytes?: number): Promise<unknown> =>
  imageGenerate.execute({ prompt: "a cat" }, {
    toolConfig: {
      provider: "openai",
      ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    },
  } as unknown as Ctx);

describe("ImageGenerate's response is bounded after decoding (C093)", () => {
  test("a gzip bomb is refused at the cap, and the body was asked for raw", async () => {
    answer = gz(bomb);
    await expect(run(1 << 20)).rejects.toThrow(/exceeded 1048576 bytes/);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.["decompress"]).toBe(false);
  });

  test("a compressed success body is decoded", async () => {
    answer = gz(gzipSync('{"data":[{"url":"https://img.example/a.png"}]}'));
    await expect(run()).resolves.toBe("image URL: https://img.example/a.png");
  });

  test("a compressed error body is decoded for the message, under its own cap", async () => {
    answer = gz(gzipSync('{"error":"quota exceeded"}'), 429);
    await expect(run()).rejects.toThrow(/\(429 .*quota exceeded/);
  });

  test("a body that is not the gzip it claims to be is refused, not parsed", async () => {
    answer = gz(new Uint8Array([0x1f, 0x8b, 8, 0, 9, 9, 9, 9, 9, 9, 9, 9]));
    await expect(run()).rejects.toThrow(/not valid gzip data/);
  });
});
