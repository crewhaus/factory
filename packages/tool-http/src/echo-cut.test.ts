/**
 * A cut through an echoed credential does not leak what is left of it
 * (C050, net review of 0.7.1).
 *
 * The scrubber replaces WHOLE secret forms, and it ran after the output had
 * been cut. A cut that splits the secret left a prefix no form matches: an
 * allow-listed plain-text echo endpoint, with the path padded so the cut
 * lands one character before the secret ends, returned every character of
 * the credential but the last through HttpWaitFor and HttpPaginate (both
 * read-only, via the 200-character non-JSON preview) and HttpRequest (via
 * its maxBytes cut). DownloadFile wrote the echo into the workspace, where a
 * later Read returns it whole.
 */
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
  httpPaginate,
  httpRequest,
  httpWaitFor,
  registerHttpConfig,
} from "./index";

const VAR = "CREWHAUS_TEST_ECHO_CUT_TOKEN";
// Built from parts, so no secret-shaped literal sits in the source.
const SECRET = ["ghp", "_R3alS3cretTokenValue", "0123456789abcdefXYZ"].join("");
const auth = { type: "bearer" as const, envVar: VAR };

/** Every prefix of the secret at least `min` characters long that appears in `text`. */
function leakedPrefixes(text: string, min = 8): number {
  let longest = 0;
  for (let n = min; n <= SECRET.length; n++) if (text.includes(SECRET.slice(0, n))) longest = n;
  return longest;
}

let server: ReturnType<typeof Bun.serve>;
/** Called as the echo server answers each request. */
const served: { onRequest: (() => void) | undefined } = { onRequest: undefined };
let origin = "";
let workspace = "";
const originalCwd = process.cwd();

beforeAll(() => {
  process.env[VAR] = SECRET;
  // A plain-text debug endpoint: it quotes the request line, then the header.
  // The model controls the path, and so where a cut falls.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      served.onRequest?.();
      return new Response(
        `GET ${u.pathname}${u.search}\nAuthorization: ${req.headers.get("authorization")}\n`,
        { headers: { "content-type": "text/plain" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-http-echo-")));
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

/** A path that puts the secret's last character just past a cut at `cut` characters. */
function pathCutAt(cut: number, missing = 1): string {
  // "GET " (4) + path + "\nAuthorization: Bearer " (23) → the secret starts at 27 + path.
  const pathLength = cut - 27 - (SECRET.length - missing);
  return `/${"a".repeat(pathLength - 1)}`;
}

describe("a cut through an echoed credential leaves none of it (C050)", () => {
  test("control: the whole echo is redacted", async () => {
    const out = String(await httpRequest.execute({ url: `${origin}/x`, auth }));
    expect(out).toContain("Bearer <redacted>");
    expect(leakedPrefixes(out)).toBe(0);
  });

  test("HttpWaitFor's non-JSON preview, cut inside the secret, carries none of it", async () => {
    // The poll only ends at its deadline (a non-JSON body never meets the
    // condition), and a real 300 ms one raced the first answer: on a loaded
    // CI runner the request was still open when it passed, and the result
    // said "deadline elapsed" instead of carrying the preview. So the
    // deadline here is long, and the test owns the clock the poll schedules
    // by: once the server has answered, Date.now reads an hour later, so the
    // poll finishes reading that answer (its abort timer is real and far
    // off) and then finds its time up instead of polling again.
    let checked = 0;
    const realNow = Date.now.bind(Date);
    let answered = false;
    served.onRequest = () => {
      answered = true;
    };
    const clock = spyOn(Date, "now").mockImplementation(() =>
      answered ? realNow() + 3_600_000 : realNow(),
    );
    try {
      for (const missing of [1, 5, 20]) {
        answered = false;
        const out = String(
          await httpWaitFor.execute({
            url: `${origin}${pathCutAt(200, missing)}`,
            auth,
            expectJson: { path: "x", op: "exists" },
            timeoutMs: 60_000,
            intervalMs: 60_000,
          }),
        );
        const result = JSON.parse(out) as { attempts: number; lastError: string };
        expect({ missing, attempts: result.attempts }).toEqual({ missing, attempts: 1 });
        expect(out).toContain("first 200 characters");
        expect({ missing, leaked: leakedPrefixes(out) }).toEqual({ missing, leaked: 0 });
        // The cut part is trimmed where the cut is made, not left for the
        // scrubber's backstop to find: the preview ends where the secret began.
        expect(result.lastError.endsWith("Authorization: Bearer ")).toBe(true);
        checked += 1;
      }
    } finally {
      clock.mockRestore();
      served.onRequest = undefined;
    }
    expect(checked).toBe(3);
  });

  test("HttpPaginate's preview, cut inside the secret, carries none of it", async () => {
    const out = String(
      await httpPaginate.execute({
        url: `${origin}${pathCutAt(200)}`,
        auth,
        style: "link",
        maxPages: 1,
        timeoutMs: 5_000,
      }),
    );
    expect(out).toContain("first 200 characters");
    expect(leakedPrefixes(out)).toBe(0);
  });

  test("HttpRequest's maxBytes cut inside the secret carries none of it, and says it cut", async () => {
    let checked = 0;
    for (const missing of [1, 12]) {
      const out = String(
        await httpRequest.execute({
          url: `${origin}${pathCutAt(1024, missing)}`,
          auth,
          maxBytes: 1024,
        }),
      );
      expect(out).toContain('"truncated":true');
      expect({ missing, leaked: leakedPrefixes(out) }).toEqual({ missing, leaked: 0 });
      expect((JSON.parse(out) as { body: string }).body.endsWith("Authorization: Bearer ")).toBe(
        true,
      );
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  test("DownloadFile refuses a body that echoes the credential, and writes nothing", async () => {
    const out = String(
      await downloadFile.execute({ url: `${origin}/debug`, path: "out.txt", auth }),
    );
    expect(out).toContain("contains the credential this call sent");
    expect(leakedPrefixes(out)).toBe(0);
    expect(existsSync(path.join(workspace, "out.txt"))).toBe(false);
    // Without a credential there is nothing to echo, and the file is written.
    const plain = String(await downloadFile.execute({ url: `${origin}/plain`, path: "plain.txt" }));
    expect(plain).toContain('"path":"plain.txt"');
    expect(existsSync(path.join(workspace, "plain.txt"))).toBe(true);
  });
});
