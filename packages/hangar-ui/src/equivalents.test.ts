/**
 * The other ways to do what an action does, from the operation row: the CLI in
 * the harness folder and from another computer, the HTTP request, `curl` and
 * `crewhaus api`. None carries a credential; the folder form needs the folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as eq from "../assets/js/inspect/equivalents.js";

type Forms =
  | {
      cli: { direct: string | null; remote: string; login: string; note: string | null };
      http: string;
      curl: string;
      api: string;
    }
  | { none: string };
const { equivalentsFor, NO_PUBLIC_API, PROTOCOL } = eq as {
  equivalentsFor(
    row: unknown,
    params?: Record<string, string>,
    where?: Record<string, unknown>,
  ): Forms;
  NO_PUBLIC_API: string;
  PROTOCOL: string;
};

const HRN = "hrn_0123456789abcdef";
const RUN = "run_01m76e6f05hp514w9j4v3qymka";
const RUNS_GET = {
  id: "runs.get",
  method: "GET",
  path: "/api/v1/runs/{run}",
  receipt: "none",
  cliTwin: { argv: ["runs", "show", "{run}", "--harness", "{hrn}"] },
};
const RUNS_CANCEL = {
  id: "runs.cancel",
  method: "POST",
  path: "/api/v1/runs/{run}/cancel",
  receipt: "harness",
  cliTwin: { argv: ["runs", "cancel", "{run}", "--harness", "{hrn}"] },
};
const EXPORTS_LIST = {
  id: "exports.list",
  method: "GET",
  path: "/api/v1/harnesses/{h}/exports",
  receipt: "none",
  cliTwin: null,
  noTwinReason: "The archives are files in Home's own folder; no command lists them.",
};

const forms = (f: Forms) => {
  if ("none" in f) throw new Error("no forms");
  return f;
};

const g = globalThis as { sessionStorage?: unknown };
const before = g.sessionStorage;
afterEach(() => {
  g.sessionStorage = before;
});

describe("equivalentsFor", () => {
  test("every form, from the row, with the harness folder held", () => {
    const f = forms(
      equivalentsFor(
        RUNS_GET,
        { run: RUN, h: HRN },
        {
          dir: "/srv/it's here",
          homeUrl: "https://home.example",
          query: { harness: HRN },
        },
      ),
    );
    expect(f.cli.direct).toBe(
      `cd '/srv/it'\\''s here' && crewhaus runs show '${RUN}' --harness '${HRN}'`,
    );
    expect(f.cli.login).toBe("crewhaus login --server 'https://home.example'");
    expect(f.cli.remote).toBe(
      `crewhaus api runs.get --param 'run=${RUN}' --query 'harness=${HRN}' --server 'https://home.example'`,
    );
    expect(f.api).toBe(`crewhaus api runs.get --param 'run=${RUN}' --query 'harness=${HRN}'`);
    expect(f.http.split("\n")).toEqual([
      `GET /api/v1/runs/${RUN}?harness=${HRN}`,
      "Authorization: Bearer $CREWHAUS_TOKEN",
      `CrewHaus-Protocol: ${PROTOCOL}`,
    ]);
    expect(f.curl).toContain(`'https://home.example/api/v1/runs/${RUN}?harness=${HRN}'`);
    expect(f.curl).toContain('"Authorization: Bearer $CREWHAUS_TOKEN"');
  });

  test("no folder form without the folder", () => {
    const f = forms(equivalentsFor(RUNS_GET, { run: RUN, h: HRN }, {}));
    expect(f.cli.direct).toBeNull();
    expect(f.cli.remote).toContain("--server <home-url>");
    expect(f.cli.login).toBe("crewhaus login --server <home-url>");
  });

  test("a receipted row names an Idempotency-Key, and its body", () => {
    const f = forms(
      equivalentsFor(
        RUNS_CANCEL,
        { run: RUN, h: HRN },
        { homeUrl: "https://h", body: { reason: "x" } },
      ),
    );
    expect(f.http).toContain("Idempotency-Key: <key>");
    expect(f.http).toContain('"reason": "x"');
    expect(f.curl).toContain("'Idempotency-Key: <key>'");
    expect(f.curl).toContain(`--data '{"reason":"x"}'`);
    expect(f.api).toContain("--body-file <body-file>");
  });

  test("a row with no twin has no folder form, and says why", () => {
    const f = forms(
      equivalentsFor(EXPORTS_LIST, { h: HRN }, { dir: "/srv/x", homeUrl: "https://h" }),
    );
    expect(f.cli.direct).toBeNull();
    expect(f.cli.note).toBe(EXPORTS_LIST.noTwinReason);
    expect(f.cli.remote).toBe(`crewhaus api exports.list --param 'h=${HRN}' --server 'https://h'`);
  });

  test("an action with no operation row says there is no public API", () => {
    expect(equivalentsFor(null, {}, {})).toEqual({ none: NO_PUBLIC_API });
    expect(equivalentsFor(undefined, {}, {})).toEqual({ none: NO_PUBLIC_API });
  });

  test("never carries this tab's session", () => {
    const secret = ["cha", "S".repeat(43)].join("_");
    g.sessionStorage = {
      getItem: () => secret,
      setItem: () => {},
      removeItem: () => {},
    };
    const f = forms(
      equivalentsFor(
        RUNS_CANCEL,
        { run: RUN, h: HRN },
        { dir: "/srv/x", homeUrl: "https://h", body: {} },
      ),
    );
    expect(JSON.stringify(f)).not.toContain(secret);
    expect(JSON.stringify(f)).not.toContain("S".repeat(16));
  });

  test("a value with a control character becomes its placeholder", () => {
    const f = forms(
      equivalentsFor(RUNS_GET, { run: "run_1\u001b[201~", h: HRN }, { dir: "/srv/x" }),
    );
    expect(f.cli.direct).toBe(`cd '/srv/x' && crewhaus runs show <run> --harness '${HRN}'`);
    expect(f.http).toContain("/api/v1/runs/<run>");
    expect(JSON.stringify(f)).not.toContain("\u001b");
  });
});
