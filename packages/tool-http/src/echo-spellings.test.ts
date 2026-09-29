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
      };
      return new Response(bodies[new URL(req.url).pathname.slice(1)] ?? "?");
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

const visiblePieces = (text: string): string[] => PIECES.filter((p) => text.includes(p));

describe("an echo escaped character by character is scrubbed (C050)", () => {
  for (const spelling of ["stj", "stjlower", "lowerpct", "html", "htmldec", "mixed"]) {
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
  for (const spelling of ["stj", "lowerpct", "html"]) {
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
