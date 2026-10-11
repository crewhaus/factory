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
import { heapStats } from "bun:jsc";
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

/**
 * Run `call`, and each time a text of a million characters or more is
 * searched for `needle` (the scrubber looks for the credential in the text
 * and in each decoded view of it), count the plain objects still alive
 * after a full collection. `peak` is the most seen, less those alive before
 * the call. A count, not the process's RSS: RSS moves with the allocator
 * and with every other test in the process, and the 512 MiB bound this
 * test had sat only 1.6x above what a quiet machine measured.
 */
async function liveObjectsWhileSearched<T>(
  needle: string,
  call: () => Promise<T>,
): Promise<{ value: T; peak: number; searches: number }> {
  const liveObjects = (): number => {
    Bun.gc(true);
    return heapStats().objectTypeCounts["Object"] ?? 0;
  };
  const realIndexOf = String.prototype.indexOf;
  const realIncludes = String.prototype.includes;
  let searches = 0;
  let most = 0;
  const sample = (text: string, search: unknown): void => {
    if (search !== needle || text.length < 1_000_000) return;
    searches += 1;
    most = Math.max(most, liveObjects());
  };
  const before = liveObjects();
  String.prototype.indexOf = function (this: string, search: string, position?: number) {
    sample(this, search);
    return realIndexOf.call(this, search, position);
  };
  String.prototype.includes = function (this: string, search: string, position?: number) {
    sample(this, search);
    return realIncludes.call(this, search, position);
  };
  try {
    const value = await call();
    return { value, peak: Math.max(0, most - before), searches };
  } finally {
    String.prototype.indexOf = realIndexOf;
    String.prototype.includes = realIncludes;
  }
}

describe("scrubbing a large escaped body costs about its size (bounds review)", () => {
  // 0.7.1's first cut of the escaped-spelling scrubber built an object per
  // escape, about 8.7 million for this body, and held them all while it
  // searched the decoded view: +1.1 GiB of RSS in either tool. Now a pass
  // builds only the decoded text. One test, both tools.
  test("HttpRequest and DownloadFile with a credential, on 25 MiB of escapes", async () => {
    const maxBytes = 25 * 1024 * 1024;
    const { value, peak, searches } = await liveObjectsWhileSearched(SECRET, async () => ({
      request: String(await httpRequest.execute({ url: `${origin}/escapes`, auth, maxBytes }, {})),
      download: String(
        await downloadFile.execute(
          { url: `${origin}/escapes`, path: "escapes.bin", auth, maxBytes },
          {},
        ),
      ),
    }));
    // Booleans, not the text: a failure must not print 25 MiB.
    expect(value.request.startsWith('{"status":200')).toBe(true);
    expect(value.request.includes("<redacted>%41")).toBe(false);
    expect(value.download.includes('"path":"escapes.bin"')).toBe(true);
    // The body was searched for the credential, so the count saw the scrub.
    expect(searches).toBeGreaterThan(0);
    // One object per escape would be millions; a handful is the call itself.
    expect(peak).toBeLessThan(100_000);
  }, 60_000);
});
