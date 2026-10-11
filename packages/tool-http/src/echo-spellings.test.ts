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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
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

/**
 * Run `body` with every timer of exactly `ms` milliseconds held: scheduled
 * never, so a deadline of that length cannot fire however slow the runner
 * is, while its clock (`expired()`) still runs. Other timers run as usual.
 * The same helper as index.test.ts's.
 */
async function withTimersHeld<T>(ms: number, body: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  const held = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) =>
    delay === ms
      ? (0 as unknown as ReturnType<typeof setTimeout>)
      : realSetTimeout(fn, delay, ...rest)) as typeof setTimeout);
  try {
    return await body();
  } finally {
    held.mockRestore();
  }
}

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
  // The 300ms deadline's timer is held, so it cannot abort a poll however
  // slow the runner; its clock still ends the loop between polls. So every
  // answer is judged on a body the poll really read. With the timer armed,
  // /echo answering 350ms late (CI has taken 300-375ms for one loopback)
  // cut every poll off, and the `false` answers held only vacuously: judging
  // the raw body, the 0.7.0 defect, passed.
  const waitFor = async (
    value: string,
  ): Promise<{ met: boolean; lastStatus?: number; lastError?: string }> =>
    JSON.parse(
      String(
        await withTimersHeld(300, () =>
          httpWaitFor.execute(
            {
              url: `${origin}/echo`,
              auth,
              expectJson: { path: "headers.x-api-key", op: "contains", value },
              intervalMs: 50,
              timeoutMs: 300,
            },
            {},
          ),
        ),
      ),
    );

  test("a correct prefix and a wrong one get the same answer", async () => {
    // The right prefix, a wrong one, and the whole secret, which is not
    // "found" either.
    const guesses = [SECRET.slice(0, 10), "ZZZZZZZZZZ", SECRET];
    for (const [guess, value] of guesses.entries()) {
      const { met, lastStatus, lastError } = await waitFor(value);
      // Labelled by index: a failure must not print the guess. A 200 with no
      // error is a body that was read, parsed and judged.
      expect({ guess, met, lastStatus, lastError }).toEqual({
        guess,
        met: false,
        lastStatus: 200,
        lastError: undefined,
      });
    }
    // Three asks wait out their 300ms, and a slow runner's polls add to that.
  }, 20_000);

  test("an echo nested as a JSON string in a JSON string is no oracle either (bounds review)", async () => {
    // The 300ms deadline's timer is held, so it cannot abort a poll however
    // slow the runner; its clock still ends the loop between polls. So every
    // answer below is judged on a body the poll really read. With the timer
    // armed, a loopback as slow as CI's (300-375ms) was cut off: the `true`
    // answer came back false, and the `false` ones held only vacuously.
    const ask = async (
      value: string,
    ): Promise<{ met: boolean; lastStatus?: number; lastError?: string }> =>
      JSON.parse(
        String(
          await withTimersHeld(300, () =>
            httpWaitFor.execute(
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
        ),
      );
    const guesses = [SECRET.slice(0, 10), "ZZZZZZZZZZ", SECRET.slice(0, 14)];
    for (const [guess, value] of guesses.entries()) {
      const { met, lastStatus, lastError } = await ask(value);
      // Labelled by index: a failure must not print the guess. A 200 with no
      // error is a body that was read, parsed and judged.
      expect({ guess, met, lastStatus, lastError }).toEqual({
        guess,
        met: false,
        lastStatus: 200,
        lastError: undefined,
      });
    }
    // The field's other text is still judged.
    expect((await ask('"raw"')).met).toBe(true);
    // Three asks wait out their 300ms, and a slow runner's polls add to that.
  }, 20_000);

  test("a condition on a field that holds no credential still works", async () => {
    // The 2s timer is held, so it cannot cut the read however slow the
    // runner: /echo is ready at once, so the first body read meets the
    // condition. Armed, a reply later than 2s came back `met: false`.
    const out = JSON.parse(
      String(
        await withTimersHeld(2_000, () =>
          httpWaitFor.execute(
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
      ),
    );
    expect({ met: out.met, stoppedBy: out.stoppedBy }).toEqual({
      met: true,
      stoppedBy: "condition",
    });
  });
});

/**
 * Run `call`, and each time a text of a million characters or more is
 * searched for `needle` (the scrubber looks for the credential in the text
 * and in each decoded view of it), count the heap cells of every type
 * still alive after a full collection: a record per escape shows up
 * whether it is a plain object, an array, a map or a closure. `peak` is the
 * most seen, less those alive before the call. A count, not the process's
 * RSS: RSS moves with the allocator and with every other test in the
 * process, and the 512 MiB bound this test had sat only 1.6x above what a
 * quiet machine measured.
 */
async function liveObjectsWhileSearched<T>(
  needle: string,
  call: () => Promise<T>,
): Promise<{ value: T; peak: number; searches: number }> {
  const liveObjects = (): number => {
    Bun.gc(true);
    let cells = 0;
    for (const count of Object.values(heapStats().objectTypeCounts)) cells += count;
    return cells;
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
    // A record per escape is about 8.7 million cells, of whatever type; the
    // call itself leaves a few thousand.
    expect(peak).toBeLessThan(100_000);
  }, 60_000);
});
