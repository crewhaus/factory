/**
 * Failed runs grouped by cause. A credential supplied by one shared env file groups the
 * runs of every harness reading it; two files, or a name the process supplies, keep them
 * apart. Failure messages never group across harnesses. Rate limits group by episode, a
 * success clears a group, and a newer spec failing the same way replaces the older one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DAY,
  HOUR,
  MIN,
  NOW,
  failure,
  harnessDir,
  run,
  tempRoot,
  testFacts,
} from "./__test__/fleet";
import { type CauseFacts, causeOf } from "./causes";
import { assembleInbox, foldHarness } from "./fold";
import type { HarnessFacts } from "./types";

const H = ["hrn_000000000000000a", "hrn_000000000000000b", "hrn_000000000000000c"] as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function root(): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  return t.root;
}

function inbox(
  dirs: readonly string[],
  facts: HarnessFacts = testFacts(),
  state: "open" | "all" = "open",
) {
  return assembleInbox(
    dirs.map((dir, i) => foldHarness(dir, facts, NOW, { harness: H[i] as string })),
    NOW,
    { state },
  );
}

/** Ten failed `auth` runs spread over the harnesses given. */
function tenAuthFailures(dirs: readonly string[]): void {
  for (let i = 0; i < 10; i++) {
    run(dirs[i % dirs.length] as string, {
      at: NOW - (i + 1) * MIN,
      state: "failed",
      failureClass: "auth",
    });
  }
}

describe("credential causes", () => {
  test("ten failed runs on three harnesses whose chains share one env file are one group", () => {
    const r = root();
    const shared = join(r, "shared.env");
    writeFileSync(shared, "ANTHROPIC_API_KEY=x\n");
    const dirs = ["a", "b", "c"].map((name) => harnessDir(r, name));
    for (const dir of dirs) symlinkSync(shared, join(dir, ".env"));
    tenAuthFailures(dirs);
    const groups = inbox(dirs).items.filter((i) => i.kind === "credential");
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.affected.count).toBe(10);
    expect(group?.affected.runs).toHaveLength(10);
    expect(group?.harnesses).toEqual([...H]);
    expect(group?.harness).toBeUndefined();
    expect(group?.cause?.kind).toBe("credential");
    expect(group?.cause?.id).toMatch(/^credential:anthropic:ANTHROPIC_API_KEY@[0-9a-f]{16}$/);
    expect(group?.title.params).toMatchObject({ runs: 10, harnesses: 3 });
  });

  test("two env files defining the same name are two groups", () => {
    const r = root();
    const dirs = ["a", "b"].map((name) => harnessDir(r, name));
    for (const dir of dirs) writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=x\n");
    tenAuthFailures(dirs);
    const groups = inbox(dirs).items.filter((i) => i.kind === "credential");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.affected.count).sort()).toEqual([5, 5]);
  });

  test("a name the process environment supplies groups per harness", () => {
    const r = root();
    const shared = join(r, "shared.env");
    writeFileSync(shared, "ANTHROPIC_API_KEY=x\n");
    const dirs = ["a", "b", "c"].map((name) => harnessDir(r, name));
    for (const dir of dirs) symlinkSync(shared, join(dir, ".env"));
    tenAuthFailures(dirs);
    const groups = inbox(dirs, testFacts({ ANTHROPIC_AUTH_TOKEN: "set" })).items.filter(
      (i) => i.kind === "credential",
    );
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group.cause?.id).toMatch(/@hrn_[0-9a-f]{16}$/);
  });

  test("a group shows only the harnesses it is given", () => {
    const r = root();
    const shared = join(r, "shared.env");
    writeFileSync(shared, "ANTHROPIC_API_KEY=x\n");
    const dirs = ["a", "b", "c"].map((name) => harnessDir(r, name));
    for (const dir of dirs) symlinkSync(shared, join(dir, ".env"));
    tenAuthFailures(dirs);
    const [group] = inbox(dirs.slice(0, 2)).items;
    expect(group?.harnesses).toEqual([H[0], H[1]]);
    expect(group?.affected.count).toBe(7);
  });

  test("a later success clears the group in that harness", () => {
    const dir = harnessDir(root(), "a");
    run(dir, { at: NOW - 2 * HOUR, state: "failed", failureClass: "auth" });
    run(dir, { at: NOW - HOUR, state: "succeeded" });
    expect(inbox([dir]).items).toEqual([]);
    const [cleared] = inbox([dir], testFacts(), "all").items;
    expect(cleared?.state).toBe("resolved");
    expect(cleared?.resolution?.how).toBe("cleared");
  });
});

describe("other causes", () => {
  test("identical failure messages in two harnesses are two items, never one", () => {
    const r = root();
    const dirs = ["a", "b"].map((name) => harnessDir(r, name));
    for (const dir of dirs) {
      const session = `sess_${"d".repeat(16)}`;
      run(dir, { at: NOW - MIN, state: "failed", failureClass: "tool", session });
      failure(dir, session, "tool", "the git remote refused the push", NOW - MIN);
    }
    const items = inbox(dirs).items.filter((i) => i.kind === "run-failures");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.cause?.kind)).toEqual(["message", "message"]);
    expect(new Set(items.map((i) => i.harness))).toEqual(new Set([H[0], H[1]]));
  });

  test("a failure with no logged message groups by its class", () => {
    const dir = harnessDir(root(), "a");
    run(dir, { at: NOW - MIN, state: "failed", failureClass: "tool" });
    const [item] = inbox([dir]).items;
    expect(item?.cause?.id).toBe(`failure-class:${H[0]}:tool`);
    expect(item?.freshness.note).toBeUndefined();
  });

  test("when the messages cannot be read, runs group by class and the item says why", () => {
    const r = root();
    const dir = harnessDir(r, "a");
    const session = `sess_${"e".repeat(16)}`;
    run(dir, { at: NOW - MIN, state: "failed", failureClass: "tool", session });
    // The session log is a link out of the harness: it is never read.
    writeFileSync(join(r, "outside.jsonl"), "{}\n");
    symlinkSync(join(r, "outside.jsonl"), join(dir, ".crewhaus", "sessions", `${session}.jsonl`));
    const [item] = inbox([dir]).items;
    expect(item?.cause?.id).toBe(`failure-class:${H[0]}:tool`);
    expect(item?.freshness.note).toContain("could not be read");
  });

  test("rate limits group while they come within an hour of each other", () => {
    const r = root();
    const dirs = ["a", "b"].map((name) => harnessDir(r, name));
    run(dirs[0] as string, { at: NOW - 10 * MIN, state: "failed", failureClass: "rate_limit" });
    run(dirs[1] as string, { at: NOW - 40 * MIN, state: "failed", failureClass: "rate_limit" });
    run(dirs[1] as string, { at: NOW - 5 * HOUR, state: "failed", failureClass: "rate_limit" });
    const [item] = inbox(dirs).items;
    expect(item?.kind).toBe("provider-limit");
    expect(item?.cause?.id).toBe("provider-limit:anthropic:rate_limit");
    expect(item?.affected.count).toBe(2);
    expect(item?.harnesses).toEqual([H[0], H[1]]);
  });

  test("a budget failure and a spec failure group within their harness", () => {
    const dir = harnessDir(root(), "a");
    run(dir, { at: NOW - MIN, state: "failed", failureClass: "crewhaus_budget" });
    run(dir, { at: NOW - 2 * MIN, state: "failed", failureClass: "spec" });
    const ids = inbox([dir]).items.map((i) => i.cause?.id);
    expect(ids.sort()).toEqual([`budget:${H[0]}:total`, `spec:${H[0]}:unknown`]);
  });

  test("a problem with no evidence in the last week has expired", () => {
    const dir = harnessDir(root(), "a");
    run(dir, { at: NOW - 8 * DAY, state: "failed", failureClass: "tool" });
    expect(inbox([dir]).items).toEqual([]);
    expect(inbox([dir], testFacts(), "all").items[0]?.state).toBe("expired");
  });

  test("causeOf keys a newer spec apart and never carries a message", () => {
    const facts: CauseFacts = {
      harness: H[0],
      credential: {
        provider: "anthropic",
        envName: "ANTHROPIC_API_KEY",
        source: "@0011223344556677",
      },
      signatures: new Map([["sess_0000000000000001|tool", "abcdef012345"]]),
    };
    const row = (over: Record<string, unknown>) => ({ id: "r", state: "failed", at: "t", ...over });
    expect(causeOf(row({ failureClass: "spec", specHash: "h1" }), facts).id).toBe(
      `spec:${H[0]}:h1`,
    );
    expect(causeOf(row({ failureClass: "spec", specHash: "h2" }), facts).id).toBe(
      `spec:${H[0]}:h2`,
    );
    expect(causeOf(row({ failureClass: "tool", session: "sess_0000000000000001" }), facts).id).toBe(
      `message:${H[0]}:tool:abcdef012345`,
    );
    expect(causeOf(row({ failureClass: "a b/c" }), facts).id).toMatch(
      /^failure-class:hrn_000000000000000a:h[0-9a-f]{12}$/,
    );
  });
});
