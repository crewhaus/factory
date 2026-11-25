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
  PUBLISH_REASONS,
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
