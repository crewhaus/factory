/**
 * An echoed credential is scrubbed in the spellings servers actually use,
 * a download holding one is not written, and HttpWaitFor is not an oracle
 * for one (C050's residual).
 *
 * With a listed, AWS-style secret that contains `/` and `+`:
 * - System.Text.Json's default writes `+` as `\u002B`; another server
 *   percent-encodes in lower case (`%2f`, `%2b`); an HTML page writes `/`
 *   as `&#x2F;`. Each echo came back whole in HttpRequest's body, because
 *   the scrubber matched whole-string encodings only.
 * - DownloadFile's check missed the `\u002B` form and wrote the secret
 *   into the workspace.
 * - HttpWaitFor's `expectJson contains` on an echoed header answered
 *   met:true for the right prefix and met:false for a wrong one, so the
 *   secret could be read out a character per call.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  downloadFile,
  httpRequest,
  httpWaitFor,
  registerHttpConfig,
} from "./index";

const VAR = "CREWHAUS_TEST_ECHO_SPELLING_KEY";
// Built from parts, so no secret-shaped literal sits in the source.
const SECRET = ["wJalrXUtnFEMI", "K7MDENG+bPxRfiCY", "EXAMPLEKEY"].join("/");
const PIECES = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCY", "EXAMPLEKEY"];
const auth = { type: "header" as const, headerName: "X-Api-Key", envVar: VAR };

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let workspace = "";
const originalCwd = process.cwd();

beforeAll(() => {
  process.env[VAR] = SECRET;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const v = req.headers.get("x-api-key") ?? "";
      const bodies: Record<string, string> = {
        stj: `{"key":"${v.replaceAll("+", "\\u002B")}"}`,
        stjlower: `{"key":"${v.replaceAll("+", "\\u002b").replaceAll("/", "\\u002f")}"}`,
        lowerpct: `got=${encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase())}`,
        html: `<p>got ${v.replaceAll("/", "&#x2F;")}</p>`,
        htmldec: `<p>got ${v.replaceAll("/", "&#47;").replaceAll("+", "&plus;")}</p>`,
        mixed: `{"key":"${v.replaceAll("+", "\\u002B").replaceAll("/", "\\/")}"}`,
        echo: JSON.stringify({ headers: { "x-api-key": v }, status: "ready" }),
        // Bounds review: an STJ echo as a JSON string in a JSON body (its
        // `\u002B` arrives as `\\u002B`), a script's `\x2F`, and a UTF-16
        // body, which is read as UTF-8 with a NUL beside every character.
        nestedstj: JSON.stringify({ raw: stjOf(v) }),
        jsx: `var k = '${v.replaceAll("/", "\\x2F").replaceAll("+", "\\x2B")}';`,
        nestedecho: JSON.stringify({ status: "ready", outer: JSON.stringify({ raw: stjOf(v) }) }),
      };
      const at = new URL(req.url).pathname.slice(1);
      if (at === "utf16") {
        return new Response(new Uint8Array(Buffer.from(`key=${v}`, "utf16le")), {
          headers: { "content-type": "text/plain; charset=utf-16le" },
        });
      }
      if (at === "escapes") return new Response(bigEscapes);
      return new Response(bodies[at] ?? "?");
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-http-spell-")));
  process.chdir(workspace);
});

afterAll(() => {
  server.stop(true);
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, VAR);
});

beforeEach(() => {
  __setPrivateHostsAllowedForTest(true);
  registerHttpConfig({ allowed_origins: [origin], allowed_auth_envs: [VAR] });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetHttpConfig();
});

const visiblePieces = (text: string): string[] =>
  PIECES.filter((p) => text.replaceAll("\u0000", "").includes(p));

/** System.Text.Json's default spelling of the key: `+` as `\u002B`. */
function stjOf(v: string): string {
  return JSON.stringify({ key: "X" }).replace("X", v.replaceAll("+", "\\u002B"));
}

/** 25 MiB (tool-http's largest maxBytes) of escapes that spell nothing secret. */
const bigEscapes = "%41".repeat(Math.floor((25 * 1024 * 1024 - 64) / 3));

describe("an echo escaped character by character is scrubbed (C050)", () => {
  for (const spelling of [
    "stj",
    "stjlower",
    "lowerpct",
    "html",
    "htmldec",
    "mixed",
    "nestedstj",
    "jsx",
    "utf16",
  ]) {
    test(`HttpRequest: the ${spelling} echo shows none of the credential`, async () => {
      const out = String(await httpRequest.execute({ url: `${origin}/${spelling}`, auth }, {}));
      const body = JSON.parse(out).body as string;
      expect(visiblePieces(body)).toEqual([]);
      expect(body).toContain("<redacted>");
    });
  }

  test("text around the escaped echo is kept", async () => {
    const out = String(await httpRequest.execute({ url: `${origin}/html`, auth }, {}));
    expect(JSON.parse(out).body).toBe("<p>got <redacted></p>");
  });
});

describe("DownloadFile does not write an escaped echo (C050)", () => {
  for (const spelling of ["stj", "lowerpct", "html", "nestedstj", "jsx", "utf16"]) {
    test(`the ${spelling} echo is refused and nothing is written`, async () => {
      const file = `${spelling}.out`;
      const out = String(
        await downloadFile.execute({ url: `${origin}/${spelling}`, path: file, auth }, {}),
      );
      expect(out).toContain("contains the credential this call sent");
      expect(existsSync(path.join(workspace, file))).toBe(false);
    });
  }
});

describe("HttpWaitFor is judged on the scrubbed body, so it is no oracle (C050)", () => {
  const waitFor = (value: string): Promise<unknown> =>
    httpWaitFor.execute(
      {
        url: `${origin}/echo`,
        auth,
        expectJson: { path: "headers.x-api-key", op: "contains", value },
        intervalMs: 50,
        timeoutMs: 300,
      },
      {},
    );

  test("a correct prefix and a wrong one get the same answer", async () => {
    const right = JSON.parse(String(await waitFor(SECRET.slice(0, 10))));
    const wrong = JSON.parse(String(await waitFor("ZZZZZZZZZZ")));
    expect(right.met).toBe(false);
    expect(wrong.met).toBe(false);
    // The whole secret is not "found" either.
    expect(JSON.parse(String(await waitFor(SECRET))).met).toBe(false);
  });

  test("an echo nested as a JSON string in a JSON string is no oracle either (bounds review)", async () => {
    const ask = async (value: string): Promise<boolean> =>
      JSON.parse(
        String(
          await httpWaitFor.execute(
            {
              url: `${origin}/nestedecho`,
              auth,
              expectJson: { path: "outer", op: "contains", value },
              intervalMs: 50,
              timeoutMs: 300,
            },
            {},
          ),
        ),
      ).met;
    expect(await ask(SECRET.slice(0, 10))).toBe(false);
    expect(await ask("ZZZZZZZZZZ")).toBe(false);
    expect(await ask(SECRET.slice(0, 14))).toBe(false);
    // The field's other text is still judged.
    expect(await ask('"raw"')).toBe(true);
  });

  test("a condition on a field that holds no credential still works", async () => {
    const out = JSON.parse(
      String(
        await httpWaitFor.execute(
          {
            url: `${origin}/echo`,
            auth,
            expectJson: { path: "status", op: "equals", value: "ready" },
            intervalMs: 50,
            timeoutMs: 2_000,
          },
          {},
        ),
      ),
    );
    expect(out.met).toBe(true);
  });
});

describe("scrubbing a large escaped body costs about its size (bounds review)", () => {
  // 0.7.1's first cut of the escaped-spelling scrubber built an object per
  // escape: +1.1 GiB of RSS for this body in either tool, where the same
  // call without a credential grew about 150 MiB. One test, both tools:
  // RSS rarely falls back, so a second test would start above a first's
  // high-water mark and prove nothing.
  test("HttpRequest and DownloadFile with a credential, on 25 MiB of escapes", async () => {
    const maxBytes = 25 * 1024 * 1024;
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    const request = String(
      await httpRequest.execute({ url: `${origin}/escapes`, auth, maxBytes }, {}),
    );
    const download = String(
      await downloadFile.execute(
        { url: `${origin}/escapes`, path: "escapes.bin", auth, maxBytes },
        {},
      ),
    );
    const grew = process.memoryUsage().rss - before;
    // Booleans, not the text: a failure must not print 25 MiB.
    expect(request.startsWith('{"status":200')).toBe(true);
    expect(request.includes("<redacted>%41")).toBe(false);
    expect(download.includes('"path":"escapes.bin"')).toBe(true);
    expect(grew).toBeLessThan(512 * 1024 * 1024);
  }, 60_000);
});
