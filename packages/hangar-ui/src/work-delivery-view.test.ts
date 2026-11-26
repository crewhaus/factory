/**
 * Work › an item's delivery: a pull request as a card with its state and verdict in words
 * (never colour alone), "Checking with GitHub…" while a publish is not confirmed, "Publish
 * didn't finish" with Retry publishing only where trying again helps and its exact CLI twin,
 * the workspace with its checks in words, and the feed's rows naming their pull request.
 * DOM only by `createElement` and `textContent`; only operations the contract declares.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELIVERY_COPY,
  NEEDS_YOU_ROUTE,
  PUBLISH_REASONS,
  PUBLISH_WHYS,
  deliveredModel,
  publishModel,
  publishTwin,
  pullWord,
  rowDelivery,
  verdictWords,
  workspaceModel,
  workspaceTwin,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/work-delivery.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { feedModel } from "../assets/js/views/work.js";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "work-delivery.js"),
  "utf8",
);
const EMBED = readFileSync(join(import.meta.dir, "embed", "runtime.ts"), "utf8");
const CONTRACT = join(import.meta.dir, "..", "..", "control-contract", "src");
const WORK_CODES = readFileSync(join(CONTRACT, "areas", "runtime-workspace.ts"), "utf8");

const HRN = "hrn_0123456789abcdef";
const WI = "wi_01m76e6f05hp514w9j4v3qymka";
const AT = "2026-11-25T00:00:00.000Z";
const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const PASS = { checks: "pass", acceptance: "pass", sha: HEAD };

const attempt = (over: Record<string, unknown> = {}) => ({
  id: `${WI}:1`,
  attempt: 1,
  state: "done",
  at: AT,
  pr: 12,
  verdict: PASS,
  ...over,
});

const workspace = (over: Record<string, unknown> = {}) => ({
  work: WI,
  binding: "app",
  branch: "crewhaus/01m76e6f05-fix-the-date-parser",
  state: "open",
  baseSha: SHA,
  headSha: HEAD,
  attempts: [attempt()],
  outcome: { pr: 12, state: "open", at: AT, url: "https://github.com/acme/app/pull/12" },
  checks: [
    { name: "bun test", exit: 0, passed: true },
    { name: "bun run lint", exit: 2, passed: false },
  ],
  ...over,
});

describe("a pull request", () => {
  test("every state has its words and a mark, and the verdict is words", () => {
    const words = [
      { state: "open" },
      { state: "open", review: "approved" },
      { state: "open", review: "changes-requested" },
      { state: "merged" },
      { state: "merged", changed: true },
      { state: "closed" },
      { state: "reverted" },
    ].map((o) => pullWord({ pr: 1, at: AT, ...o }).word);
    expect(words).toEqual([
      "In review",
      "In review",
      "Changes requested",
      "Merged",
      "Merged with changes by a maintainer",
      "Closed without merging",
      "Reverted",
    ]);
    expect(verdictWords(PASS)).toEqual(["Checks passed", "Acceptance check passed"]);
    expect(verdictWords({ checks: "not-run", acceptance: "not-run", sha: HEAD })).toEqual([
      "Checks did not run",
      "Acceptance check did not run",
    ]);
    expect(verdictWords(undefined)).toEqual([]);
  });

  test("is a card named by its number and the item's title, linked only over http or https", () => {
    const cards = deliveredModel(
      [
        { kind: "pr", ref: "acme/app#12" },
        { kind: "report", ref: "reports/march.md" },
      ],
      "Fix the date parser",
      workspace(),
    );
    expect(cards).toEqual([
      {
        kind: "pr",
        title: "PR #12 opened: Fix the date parser",
        ref: "acme/app#12",
        url: "https://github.com/acme/app/pull/12",
        word: "In review",
        tone: "info",
        verdict: ["Checks passed", "Acceptance check passed"],
      },
      { kind: "other", text: "report: reports/march.md" },
    ]);
    const unsafe = workspace({
      outcome: { pr: 12, state: "merged", at: AT, url: "javascript:alert(1)" },
    });
    expect(deliveredModel([{ kind: "pr", ref: "acme/app#12" }], "T", unsafe)[0]).toMatchObject({
      url: null,
      word: "Merged",
    });
    // With no workspace to read, the card still says what was opened.
    expect(deliveredModel([{ kind: "pr", ref: "acme/app#3" }], "T", null)[0]).toMatchObject({
      title: "PR #3 opened: T",
      word: "In review",
      url: null,
      verdict: [],
    });
  });
});

describe("where the last publish stands", () => {
  const open = { id: WI, state: "open" };
  const can = { "h.run.submit": true };

  test("not confirmed: checking with GitHub, and nothing to press", () => {
    for (const state of ["unknown", "started", "pushed"]) {
      const model = publishModel(workspace({ attempts: [attempt({ state })] }), open, can, HRN);
      expect(model).toMatchObject({
        kind: "checking",
        word: "Checking with GitHub…",
        retry: null,
        twin: workspaceTwin(WI, HRN),
      });
    }
    expect(publishModel(workspace(), open, can, HRN)).toBeNull();
    expect(publishModel(null, open, can, HRN)).toBeNull();
  });

  test("did not finish: why in words; retry only where it helps, for a person who may", () => {
    const failed = (code: string, more: Record<string, unknown> = {}) =>
      workspace({ attempts: [attempt({ state: "failed", code, pr: undefined, ...more })] });
    const retry = publishModel(failed("credential_unavailable"), open, can, HRN);
    expect(retry).toMatchObject({
      kind: "unfinished",
      word: "Publish didn't finish",
      retry: { label: "Retry publishing", op: "work.publish", twin: publishTwin(WI, HRN) },
      next: null,
    });
    const again = publishModel(failed("checks_failed"), open, can, HRN);
    expect(again).toMatchObject({ retry: null, next: DELIVERY_COPY.runAgain });
    expect(again.detail).toBe("A check failed.");
    const big = publishModel(failed("over_limits", { files: 21, lines: 40 }), open, can, HRN);
    expect(big.detail).toContain("21 files and 40 lines");
    expect(big.retry).toMatchObject({ label: "Publish after approval" });
    const lost = publishModel(
      workspace({ attempts: [attempt({ state: "not-done", pr: undefined })] }),
      open,
      can,
      HRN,
    );
    expect(lost).toMatchObject({ retry: { label: "Retry publishing" } });
    // Who may not, and an item that is not open, get the words and no button.
    expect(publishModel(failed("unsupported_host"), open, {}, HRN)?.retry).toBeNull();
    expect(
      publishModel(failed("unsupported_host"), { id: WI, state: "closed" }, can, HRN)?.retry,
    ).toBeNull();
    // Every refusal code the contract names has its words.
    const codes = [
      ...(/WORK_PUBLISH_CODES = deepFreeze\(\[([^\]]+)\]/.exec(WORK_CODES)?.[1] ?? "").matchAll(
        /"([a-z_]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(codes.length).toBe(10);
    expect(Object.keys(PUBLISH_REASONS).sort()).toEqual([...codes].sort());
  });

  test("a cause the code alone does not say: its own words, and a retry only for a slow or unreachable host", () => {
    const failed = (code: string, more: Record<string, unknown> = {}) =>
      workspace({ attempts: [attempt({ state: "failed", code, pr: undefined, ...more })] });
    const old = publishModel(failed("unsupported_host", { why: "git-too-old" }), open, can, HRN);
    expect(old).toMatchObject({
      detail: "This computer's git is too old for workspaces.",
      retry: null,
      next: "Update git to 2.38 or newer, then publish again.",
    });
    const several = publishModel(
      failed("unsupported_host", { why: "repository-ambiguous" }),
      open,
      can,
      HRN,
    );
    expect(several).toMatchObject({
      detail: "This harness delivers to several repositories, and none was named.",
      retry: null,
      next: "Start the item again and name the repository its change goes to.",
    });
    expect(several.detail).not.toContain("could not be reached");
    for (const why of ["host-timeout", "host-unreachable"]) {
      expect(
        publishModel(failed("unsupported_host", { why }), open, can, HRN)?.retry,
      ).toMatchObject({ label: "Retry publishing" });
    }
    // A local cause, and one with no cause recorded, never offer a retry.
    for (const why of ["host-refused", "clone-settings", "base-missing", "repository-gone"]) {
      expect(publishModel(failed("unsupported_host", { why }), open, can, HRN)?.retry).toBeNull();
    }
    expect(publishModel(failed("unsupported_host"), open, can, HRN)?.retry).toBeNull();
    // Every cause the contract names has its words.
    const whys = [
      ...(/WORK_PUBLISH_WHYS = deepFreeze\(\[([^\]]+)\]/.exec(WORK_CODES)?.[1] ?? "").matchAll(
        /"([a-z-]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(whys.length).toBe(15);
    expect(Object.keys(PUBLISH_WHYS).sort()).toEqual([...whys].sort());
  });

  test("checks with no sandbox: says so, names the remedy in technical details, and does not say to run again", () => {
    const unran = { checks: "not-run", acceptance: "not-run", sha: HEAD };
    for (const more of [{ why: "no-sandbox" }, {}]) {
      const model = publishModel(
        workspace({
          attempts: [
            attempt({
              state: "failed",
              code: "gate_failed",
              pr: undefined,
              verdict: unran,
              ...more,
            }),
          ],
        }),
        open,
        can,
        HRN,
      );
      expect(model).toMatchObject({
        detail: "The checks could not run: this computer has no sandbox for them.",
        retry: null,
        next: null,
      });
      expect(model.detail).not.toContain("did not pass");
      expect(model.technical).toContain("CREWHAUS_SANDBOX");
    }
    // A real failure still says it did not pass, and to run again.
    const real = publishModel(
      workspace({
        attempts: [
          attempt({
            state: "failed",
            code: "gate_failed",
            pr: undefined,
            verdict: { checks: "pass", acceptance: "fail", sha: HEAD },
          }),
        ],
      }),
      open,
      can,
      HRN,
    );
    expect(real).toMatchObject({
      detail: "The change did not pass its checks or its acceptance check.",
      next: DELIVERY_COPY.runAgain,
      technical: null,
    });
  });

  test("a change past the size limits says where a person decides, and its button publishes after that", () => {
    const big = (more: Record<string, unknown>) =>
      publishModel(
        workspace({
          attempts: [attempt({ state: "failed", code: "over_limits", pr: undefined, ...more })],
        }),
        open,
        can,
        HRN,
      );
    const both = big({ files: 40, lines: 900 });
    expect(both.detail).toContain("review the request in Needs you, then publish");
    expect(both.detail).toContain("It changes 40 files and 900 lines.");
    expect(both).toMatchObject({
      retry: { label: "Publish after approval", op: "work.publish" },
      link: { href: NEEDS_YOU_ROUTE, text: "Open Needs you" },
    });
    // A count that is not there is left out, never shown as zero.
    const filesOnly = big({ files: 40 });
    expect(filesOnly.detail).toContain("It changes 40 files.");
    expect(filesOnly.detail).not.toContain("0 lines");
    expect(filesOnly.detail).not.toContain("lines");
  });

  test("the twins are commands the CLI takes", () => {
    expect(publishTwin(WI, HRN)).toBe(`crewhaus work publish ${WI} --harness ${HRN}`);
    expect(workspaceTwin(WI, HRN)).toBe(`crewhaus workspace show ${WI} --harness ${HRN}`);
  });
});

describe("the workspace", () => {
  test("its branch, where it started, and each check in words", () => {
    const model = workspaceModel(
      workspace({ reasons: "It fits.", logs: [{ name: "bun test", text: "ok" }] }),
      HRN,
    );
    expect(model).toMatchObject({
      branch: "crewhaus/01m76e6f05-fix-the-date-parser",
      state: "Open",
      base: SHA.slice(0, 12),
      head: HEAD.slice(0, 12),
      checks: [
        { name: "bun test", word: "Passed", tone: "ok" },
        { name: "bun run lint", word: "Failed (exit 2)", tone: "bad" },
      ],
      hidden: false,
      reasons: "It fits.",
      logs: [{ name: "bun test", text: "ok" }],
    });
    expect(
      workspaceModel(workspace({ state: "closed", wip: true, hidden: ["content"] }), HRN),
    ).toMatchObject({
      state: "Closed. Unfinished work was kept as a commit on its branch.",
      hidden: true,
      reasons: null,
    });
    expect(workspaceModel(null, HRN)).toBeNull();
  });

  test("a declared check with no result is not run yet; 'declares no checks' only when it declares none", () => {
    const fresh = workspaceModel(
      workspace({ declared: ["bun test"], checks: undefined, attempts: [] }),
      HRN,
    );
    expect(fresh).toMatchObject({
      checks: [{ name: "bun test", word: "Not run yet", tone: "off" }],
      empty: null,
      unran: null,
    });
    const none = workspaceModel(workspace({ declared: [], checks: undefined }), HRN);
    expect(none).toMatchObject({ checks: [], empty: DELIVERY_COPY.noChecks });
    // Nothing says what the repository declares: no claim that it declares none.
    const unknown = workspaceModel(workspace({ checks: undefined, attempts: [] }), HRN);
    expect(unknown).toMatchObject({ checks: [], empty: DELIVERY_COPY.noResults });
    expect(unknown.empty).not.toBe(DELIVERY_COPY.noChecks);
    const noSandbox = workspaceModel(
      workspace({
        declared: ["bun test"],
        checks: undefined,
        attempts: [
          attempt({
            state: "failed",
            code: "gate_failed",
            why: "no-sandbox",
            verdict: { checks: "not-run", acceptance: "not-run", sha: HEAD },
          }),
        ],
      }),
      HRN,
    );
    expect(noSandbox).toMatchObject({
      checks: [{ name: "bun test", word: "Not run yet" }],
      unran: DELIVERY_COPY.noSandbox,
    });
  });
});

describe("the feed", () => {
  test("a delivered item's row names its pull request; one being looked up says so", () => {
    const entry = {
      kind: "item",
      id: WI,
      label: "Fix the date parser",
      status: "in-review",
      statusWord: "In review",
      item: { id: WI, state: "open" },
    };
    const feed = { sections: { delivered: { items: [entry] } } };
    const row = (w: unknown[]) => feedModel(feed, HRN, w).groups[0].parts[0].rows[0];
    expect(row([]).detail).toBeNull();
    expect(row([{ work: WI, outcome: { pr: 12, state: "open", at: AT } }]).detail).toBe("PR #12");
    expect(
      row([{ work: WI, outcome: { pr: 12, state: "merged", changed: true, at: AT } }]).detail,
    ).toBe("PR #12, merged with changes by a maintainer");
    expect(row([{ work: WI, publish: "unknown" }]).detail).toBe("Checking with GitHub…");
    expect(rowDelivery(null)).toBeNull();
  });
});

describe("the module", () => {
  test("ships through the runtime area's embed file; DOM by createElement and textContent only", () => {
    expect(EMBED).toContain(
      'import workDeliveryJs from "../../assets/js/views/work-delivery.js" with { type: "text" }',
    );
    expect(EMBED).toContain('"/assets/js/views/work-delivery.js"');
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE).not.toContain(banned);
    }
    expect(SOURCE).not.toContain("/api/v1/");
    const ops = [...SOURCE.matchAll(/op: "([a-z.A-Z]+)"/g)].map((m) => m[1]);
    expect(ops).toEqual(["work.publish"]);
    expect(WORK_CODES).toContain('id: "work.publish"');
  });

  test("its words carry no package names, keys or shapes", () => {
    const reasons = Object.values(PUBLISH_REASONS).map((r) => (r as { text: string }).text);
    const said = Object.values(DELIVERY_COPY).map((w) => (typeof w === "function" ? w() : w));
    const words = JSON.stringify([said, reasons]);
    for (const jargon of ["@crewhaus", "tool_config", "yaml", "wi_", "work.", "jsonl", "_"]) {
      expect(`${jargon}: ${words.includes(jargon)}`).toBe(`${jargon}: false`);
    }
  });
});
