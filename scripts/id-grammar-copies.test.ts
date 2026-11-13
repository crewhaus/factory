/**
 * Every known hand-written copy of the `sess_` and `appr_` grammars, held to the
 * contract's text. There are too many today for a check that fails on a second
 * definition, so this pins each file's count instead: a copy that drifts fails, a
 * new one fails until it is listed, and one that goes away must leave the list. A
 * copy migrates to the import when its package is next touched.
 *
 * Emitted text keeps its copies on purpose: a compiled harness does not import the
 * contract for them.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { APPROVAL_ID_PATTERN, SESSION_ID_PATTERN } from "../packages/control-contract/src/index";

const ROOT = join(import.meta.dir, "..");

/** `file → hit lines`, recounted when a copy migrates. */
const KNOWN_COPIES: Readonly<Record<string, number>> = {
  "apps/cli/src/memory-cli.ts": 1,
  "apps/cli/src/provability-cli.ts": 2,
  "apps/cli/src/runs.ts": 1,
  "apps/cli/src/security-corpus.ts": 1,
  "apps/cli/src/security-digest.ts": 1,
  "apps/cli/src/session-logs.ts": 1,
  "apps/cli/src/sessions-tail.ts": 1,
  "apps/cli/src/watchme-report.ts": 1,
  "packages/continuity-store/src/evidence.ts": 1,
  "packages/continuity-store/src/index.ts": 2,
  "packages/data-retention-engine/src/retention-config.ts": 1,
  "packages/dream-engine/src/phase1.ts": 1,
  "packages/evaluation-service/src/wire.ts": 1,
  "packages/event-log/src/index.ts": 1,
  "packages/feedback-distill/src/collect.ts": 1,
  "packages/feedback-distill/src/feedback.ts": 1,
  "packages/gateway-protocol/src/index.ts": 1,
  "packages/grader-continuity/src/artifacts.ts": 2,
  "packages/harness-inventory/src/inventory.ts": 1,
  "packages/harness-supervisor/src/spawn-contracts.ts": 1,
  "packages/provability/src/evidence.ts": 1,
  "packages/provability/src/store.ts": 1,
  "packages/runtime-core/src/janitor.ts": 1,
  // The docblock that states the rule; the grammar itself is imported.
  "packages/session-store/src/index.ts": 1,
  "packages/target-browser-driver/src/index.ts": 1,
  "packages/target-channel-bot/src/index.ts": 1,
  "packages/target-managed/src/index.ts": 1,
  "packages/tool-plan/src/index.ts": 1,
  "packages/tool-proof/src/lib/context.ts": 1,
  "packages/tool-proof/src/lib/evidence.ts": 1,
};

type Hit = { readonly file: string; readonly line: string };

function isExcluded(file: string): boolean {
  return (
    /\.test\.[a-z]+$/.test(file) ||
    /(?:^|\/)(?:__test__|__fixtures__|dist)\//.test(file) ||
    file.startsWith("packages/control-contract/")
  );
}

function grepHits(): Hit[] {
  const grep = Bun.spawnSync(
    ["git", "grep", "--untracked", "-a", "-n", "-E", "sess_\\[|appr_\\[", "--", "packages", "apps"],
    { cwd: ROOT },
  );
  expect(grep.exitCode).toBe(0);
  return new TextDecoder()
    .decode(grep.stdout)
    .split("\n")
    .filter((line) => line !== "")
    .map((row) => {
      const match = /^([^:]+):\d+:(.*)$/.exec(row);
      if (match === null) throw new Error(`unreadable hit: ${row}`);
      return { file: match[1] as string, line: match[2] as string };
    })
    .filter((hit) => !isExcluded(hit.file));
}

/** What is wrong with these hits against the list. Empty when they agree. */
function copyProblems(hits: readonly Hit[], known: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const hit of hits) {
    counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1);
    const remainder = hit.line
      .replaceAll(SESSION_ID_PATTERN, "")
      .replaceAll(APPROVAL_ID_PATTERN, "");
    if (/sess_\[|appr_\[/.test(remainder))
      problems.push(`${hit.file}: drifted: ${hit.line.trim()}`);
  }
  for (const [file, count] of counts) {
    if (known[file] !== count) problems.push(`${file}: ${count} copies, ${known[file] ?? 0} known`);
  }
  for (const file of Object.keys(known)) {
    if (!counts.has(file)) problems.push(`${file}: no copies, ${known[file]} known`);
  }
  return problems;
}

describe("known copies of the id grammars", () => {
  test("each hit holds the exact body, and the map agrees both ways", () => {
    const hits = grepHits();
    expect(copyProblems(hits, KNOWN_COPIES)).toEqual([]);
    expect(Object.keys(KNOWN_COPIES).length).toBeGreaterThanOrEqual(1);
    // This scan must find what it claims to scan.
    expect(hits.length).toBe(Object.values(KNOWN_COPIES).reduce((a, b) => a + b, 0));
    expect(hits.some((hit) => hit.line.includes(SESSION_ID_PATTERN))).toBe(true);
  });

  test("the packages that take the grammar from the contract are off the list", () => {
    const hangarServer = Object.keys(KNOWN_COPIES).filter((f) =>
      f.startsWith("packages/hangar-server/"),
    );
    expect(hangarServer).toEqual([]);
    expect(grepHits().filter((hit) => hit.file.startsWith("packages/hangar-server/"))).toEqual([]);
  });
});

describe("the check sees planted drift", () => {
  const file = "packages/x/src/a.ts";
  test("a body that changed", () => {
    expect(copyProblems([{ file, line: "/^sess_[0-9a-f]{8}$/" }], { [file]: 1 })).toEqual([
      `${file}: drifted: /^sess_[0-9a-f]{8}$/`,
    ]);
  });
  test("one good copy and one changed on the same line", () => {
    const line = "/^sess_[0-9a-f]{16}$/ or /^appr_[0-9a-z]{16}$/";
    expect(copyProblems([{ file, line }], { [file]: 1 })).toEqual([`${file}: drifted: ${line}`]);
  });
  test("a new copy, and a count that moved", () => {
    expect(copyProblems([{ file, line: SESSION_ID_PATTERN }], {})).toEqual([
      `${file}: 1 copies, 0 known`,
    ]);
    expect(copyProblems([{ file, line: SESSION_ID_PATTERN }], { [file]: 2 })).toEqual([
      `${file}: 1 copies, 2 known`,
    ]);
  });
  test("a copy that went away must leave the list", () => {
    expect(copyProblems([], { [file]: 1 })).toEqual([`${file}: no copies, 1 known`]);
  });
});
