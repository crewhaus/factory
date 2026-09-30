/**
 * A clip through a token the server echoed leaves none of it (net attacker
 * review; tool-http's C050 fix, carried over).
 *
 * An API error's body is quoted clipped to 500 characters, and a byte cap
 * cuts a read. The redactor ran on the finished result and matched whole
 * spellings of the token, so a clip through an echoed `Authorization`
 * header returned every character of it but the last. The body is now
 * scrubbed where it is read, before any tool clips it, and a cut read is
 * trimmed of the start of the token.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __setPrivateHostsAllowedForTest, _resetCodehostConfig, rateLimitStatus } from "./index";
import { readCapped } from "./net";

const TOKEN_VAR = "CREWHAUS_TEST_CH_ECHO_TOKEN";
const TOKEN = "configured-token-value-4e2a9c";
const BEARER = "Bearer ";

let pad = 0;
let hits = 0;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      hits++;
      // A proxy that quotes the rejected credential in a plain-text 401.
      const body = `${"p".repeat(pad)}${req.headers.get("authorization")}${" ".repeat(2_000)}`;
      return new Response(body, { status: 401 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  hits = 0;
  process.env[TOKEN_VAR] = TOKEN;
  __setPrivateHostsAllowedForTest(true);
});

afterEach(() => {
  delete process.env[TOKEN_VAR];
  __setPrivateHostsAllowedForTest(false);
  _resetCodehostConfig();
});

const KEEP = [1, 5, 12, TOKEN.length - 1];

describe("an echoed token cut by a clip or a cap", () => {
  test("an API error's 500-character excerpt carries none of it", async () => {
    const toolConfig = { allowed_origins: [origin], base_url: origin, token_env: TOKEN_VAR };
    let checked = 0;
    for (const keep of KEEP) {
      // "HTTP 401: " is not part of the clip; the body's first 500 are.
      pad = 500 - BEARER.length - keep;
      const out = String(await rateLimitStatus.execute({}, { toolConfig } as never));
      expect({ keep, starts: out.startsWith("HTTP 401: ") }).toEqual({ keep, starts: true });
      expect({ keep, leaked: out.includes(`${BEARER}${TOKEN.slice(0, keep)}`) }).toEqual({
        keep,
        leaked: false,
      });
      checked++;
    }
    expect(checked).toBe(KEEP.length);
    expect(hits).toBe(KEEP.length);
  });

  test("a read the cap cut ends where the token began", async () => {
    let checked = 0;
    for (const keep of KEEP) {
      const head = `${"p".repeat(1_000)}${BEARER}`;
      const res = new Response(`${head}${TOKEN}${" ".repeat(100)}`);
      const capped = await readCapped(res, head.length + keep, undefined, [TOKEN]);
      expect({ keep, text: capped.text, truncated: capped.truncated }).toEqual({
        keep,
        text: head,
        truncated: true,
      });
      checked++;
    }
    expect(checked).toBe(KEEP.length);
  });
});
