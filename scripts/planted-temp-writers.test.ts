/**
 * Two ways a runtime write lands outside the workspace through a symlink a
 * model planted (Grep finds the names; a GitApplyPatch patch creates the
 * link), and a guard for each:
 *
 * 1. A write-then-rename through a temp whose name is derived from the target
 *    (`${path}.tmp`, `${path}.${pid}.tmp`, `${path}.tmp-${pid}-${ms}`): the
 *    write follows a link put at that name beforehand, dangling or not, and
 *    the rename then puts the link in place of the file. 0.7.0's session
 *    store, approvals log, settings write-back, routing scoreboard, dream
 *    state, prompt-cache record, optimize write-back, DEK store, alert
 *    history trim and watch-me store all did this.
 * 2. An in-place append (`appendFileSync`, `appendFile`), which follows a link
 *    AT the file. 0.7.0's event log, approvals log, routing observations,
 *    watch-me capture sidecar, alert history, watch-me logs and eval tool
 *    cassette all did this.
 *
 * 0.7.1 moved each of those to @crewhaus/tool-safety/fs (`writeFileSafe`: a
 * random temp opened O_EXCL|O_NOFOLLOW, a leaf check, the rename;
 * `appendContained`). These guards find every remaining site in non-test
 * source and fail on any not listed below with its reason. The lists are
 * checked too: an entry whose file no longer has that many sites fails, so a
 * fixed writer drops out, except entries another 0.7.1 unit is fixing in
 * parallel, which may reach zero.
 *
 * What these guards cannot see, and what covers it instead:
 * - a plain `writeFileSync` at a leaf, which also follows a link: it is how
 *   most tools write their output through paths they contain first, so it is
 *   not listed site by site;
 * - a link planted at a store's DIRECTORY, which a write rooted at that
 *   directory follows as its root.
 * The runtime's own `.crewhaus` stores are held to both by behavioural tests
 * that plant each link: session-store, event-log, runtime-core (watch-me
 * sidecar, alert history), dream-engine, prompt-cache-manager, watchme-store,
 * routing-store, permission-engine and eval-runner, each in its
 * `planted-*.test.ts` or `tool-record.test.ts`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTestOnly } from "./test-only";

const ROOT = dirname(import.meta.dir);

type Exemption = {
  /** Derived temp names in this file that the reason covers. */
  readonly sites: number;
  readonly reason: string;
  /** Being fixed by another 0.7.1 unit; the count may fall to zero. */
  readonly pendingElsewhere?: true;
};

// Checked, not assumed (watchme-store was listed here while the CLI opened it
// in the workspace): each HOME entry's root defaults to the home directory
// (CREWHAUS_HANGAR_ROOT / CREWHAUS_REGISTRY_ROOT move it; nothing moves it on
// a model's say).
const HOME =
  "writes under ~/.crewhaus by default (only an operator's environment variable moves it), where no model tool can write";
const WORKSPACE_FOLLOW_UP =
  "FOLLOW-UP: writes inside the workspace, so a planted link reaches it; move to writeFileSafe";

const EXEMPT: Readonly<Record<string, Exemption>> = {
  "apps/cli/src/hangar-cmd.ts": { sites: 1, reason: `the Hangar lock; ${HOME}` },
  "apps/cli/src/hoist-models.ts": {
    sites: 1,
    reason: `\`crewhaus hoist-models\` rewrites .crewhaus/routing/arms.jsonl. ${WORKSPACE_FOLLOW_UP}`,
  },
  "apps/cli/src/judge-calibrate.ts": {
    sites: 1,
    reason: "the temp name carries 4 random bytes, so it cannot be planted in advance",
  },
  "apps/cli/src/memory-cli.ts": {
    sites: 1,
    reason: `\`crewhaus memory migrate\` rewrites .crewhaus memory files. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/checkpoint-store/src/index.ts": {
    sites: 2,
    reason: "each temp name carries 4 random bytes, so it cannot be planted in advance",
  },
  "packages/continuity-store/src/evidence.ts": {
    sites: 1,
    reason: "C070: the 0.7.1 containment unit moves continuity-store to writeFileSafe",
    pendingElsewhere: true,
  },
  "packages/continuity-store/src/index.ts": {
    sites: 1,
    reason: "C070: the 0.7.1 containment unit moves continuity-store to writeFileSafe",
    pendingElsewhere: true,
  },
  "packages/hangar-server/src/actions.ts": {
    sites: 1,
    reason: `.crewhaus/retention.json pins, named by the server's pid. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/hangar-server/src/feedback-ops.ts": {
    sites: 1,
    reason: `a spec edit from the Hangar console, named by the server's pid. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/hangar-server/src/rollups.ts": { sites: 1, reason: `the rollup cache; ${HOME}` },
  "packages/harness-registry/src/registry.ts": {
    sites: 1,
    reason: `the harness registry; ${HOME}, and the name carries random characters`,
  },
  "packages/harness-supervisor/src/prepare.ts": {
    sites: 1,
    reason: `.crewhaus/run/hooks.json under a fixed temp name. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/harness-supervisor/src/runfiles.ts": {
    sites: 1,
    reason: `.crewhaus/run's runfile, named by the manager's pid. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/harness-supervisor/src/trace-pump.ts": {
    sites: 1,
    reason: `the trace-pump cursor, named by the manager's pid. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/secrets-manager/src/backends/file.ts": {
    sites: 1,
    reason: `a rotated secret under a fixed temp name in the operator's secrets directory. ${WORKSPACE_FOLLOW_UP}`,
  },
  "packages/tool-fleet/src/index.ts": {
    sites: 1,
    reason: "the name carries 4 random bytes, and the tool contains both the temp and the target",
  },
  "packages/tool-ledger/src/index.ts": {
    sites: 1,
    reason: "InvoiceRender: the 0.7.1 containment unit moves it to writeFileSafe",
    pendingElsewhere: true,
  },
  "packages/tool-registry/src/index.ts": {
    sites: 1,
    reason: `ManifestDependencySet's temp is opened with flag "wx" (O_CREAT|O_EXCL), which fails on any existing name, a link included`,
  },
  "packages/tool-secrets/src/lib/write.ts": {
    sites: 1,
    reason:
      'opened with flag "wx" (O_CREAT|O_EXCL), which fails on any existing name, a link included',
  },
  "packages/tool-state/src/store.ts": {
    sites: 2,
    reason:
      'opened with flag "wx" (O_CREAT|O_EXCL), which fails on any existing name, a link included',
  },
};

const APPEND_FOLLOW_UP =
  "FOLLOW-UP: appends inside the workspace, so a link planted at the file is followed; move to appendContained";

const APPEND_EXEMPT: Readonly<Record<string, Exemption>> = {
  "apps/cli/src/index.ts": {
    sites: 1,
    reason:
      "`crewhaus rate` mirrors a rating into .crewhaus/sessions/<id>.jsonl right after the event log's contained append to the same file in the same command, which refuses a link there first",
  },
  "apps/cli/src/watchme-report.ts": {
    sites: 1,
    reason: "the report seam's appendFile; no report step calls it (they write whole files)",
  },
  "packages/audit-log/src/file-anchor-store.ts": {
    sites: 1,
    reason: `the audit anchor file in the directory \`audit verify --anchor file:<dir>\` names. ${APPEND_FOLLOW_UP}`,
  },
  "packages/canary-controller/src/experiment.ts": {
    sites: 1,
    reason: `an experiment's outcome ledger under .crewhaus/experiments. ${APPEND_FOLLOW_UP}`,
  },
  "packages/citation-tracker/src/index.ts": {
    sites: 2,
    reason: `a research run's fetches.jsonl and citations.jsonl under .crewhaus/research, written while the model runs. ${APPEND_FOLLOW_UP}`,
  },
  "packages/feedback-distill/src/review-queue.ts": {
    sites: 2,
    reason: `the feedback review queue under .crewhaus/feedback. ${APPEND_FOLLOW_UP}`,
  },
  "packages/hangar-server/src/advisor.ts": {
    sites: 2,
    reason: `the Hangar's advisor ledger and reports in a harness's .crewhaus. ${APPEND_FOLLOW_UP}`,
  },
  "packages/hangar-server/src/evals-ops.ts": {
    sites: 1,
    reason: `the Hangar's eval ledgers in a harness's .crewhaus. ${APPEND_FOLLOW_UP}`,
  },
  "packages/hangar-server/src/security-ops.ts": {
    sites: 1,
    reason: `the Hangar's security ledger in a harness's .crewhaus. ${APPEND_FOLLOW_UP}`,
  },
  "packages/harness-supervisor/src/queue.ts": {
    sites: 1,
    reason: `the supervisor's job store under .crewhaus/run. ${APPEND_FOLLOW_UP}`,
  },
  "packages/harness-supervisor/src/runfiles.ts": {
    sites: 2,
    reason: `the supervisor's run ledger under .crewhaus/run. ${APPEND_FOLLOW_UP}`,
  },
  "packages/harness-supervisor/src/supervisor.ts": {
    sites: 2,
    reason: `a supervised harness's log under .crewhaus/run. ${APPEND_FOLLOW_UP}`,
  },
  "packages/harness-supervisor/src/trace-pump.ts": {
    sites: 1,
    reason: `the trace pump's events file under .crewhaus/run. ${APPEND_FOLLOW_UP}`,
  },
  "packages/smoke-harness/src/runtime.ts": {
    sites: 1,
    reason: "GITHUB_STEP_SUMMARY, a file the CI runner creates outside the workspace",
  },
  "packages/target-channel-bot/src/index.ts": {
    sites: 1,
    reason: `emitted daemon code: the reaction join file under .crewhaus. ${APPEND_FOLLOW_UP}`,
  },
  "packages/target-managed/src/index.ts": {
    sites: 1,
    reason: `emitted daemon code: a tenant's feedback file under .crewhaus/feedback. ${APPEND_FOLLOW_UP}`,
  },
};

/** The lines of `source` that are code, not comments. */
function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const code = line.trimStart();
    return !(code.startsWith("*") || code.startsWith("/*") || code.startsWith("//"));
  });
}

/**
 * A template literal with `.tmp` anywhere in it (`${p}.tmp`, `${p}.tmp-${pid}`,
 * `${p}.${pid}.tmp`), or `.tmp` concatenated on (`p + ".tmp"`).
 */
const TEMP_TEMPLATE = /`[^`]*\.tmp[^`]*`/g;
const TEMP_CONCAT = /\+\s*["'][^"'\n]*\.tmp[^"'\n]*["']/g;

/** Derived temp names on non-comment lines, per file. */
function derivedTempSites(source: string): number {
  let count = 0;
  for (const code of codeLines(source)) {
    count += (code.match(TEMP_TEMPLATE) ?? []).length + (code.match(TEMP_CONCAT) ?? []).length;
  }
  return count;
}

/**
 * Raw in-place appends on non-comment lines: `appendFileSync(` and a bare
 * `appendFile(` call (node:fs/promises, or emitted code), not a method on a
 * seam object (`fs.appendFile(`) and not a declaration (`appendFile(path: string)`).
 */
const RAW_APPEND = /\bappendFileSync\s*\(|(?<![.\w])appendFile\s*\((?!\s*\w+\??\s*:)/g;

function rawAppendSites(source: string): number {
  let count = 0;
  for (const code of codeLines(source)) count += (code.match(RAW_APPEND) ?? []).length;
  return count;
}

function trackedSources(): string[] {
  const out = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "packages/*/src/*.ts",
      "packages/*/src/**/*.ts",
      "apps/*/src/*.ts",
      "apps/*/src/**/*.ts",
    ],
    { cwd: ROOT },
  );
  return (
    out.stdout
      .toString()
      .split("\0")
      .filter((f) => f !== "" && !isTestOnly(f))
      // The safe writer itself names its random temps and appends.
      .filter((f) => !f.startsWith("packages/tool-safety/"))
  );
}

test("the judge counts code, not comments", () => {
  expect(derivedTempSites("const t = `${p}.tmp`;\n// `${p}.tmp` in a comment\n * `x.tmp`")).toBe(1);
  expect(derivedTempSites("const a = `${p}.${pid}.tmp`, b = `${q}.tmp`;")).toBe(2);
  expect(derivedTempSites("writeFileSafe(root, rel, data, { overwrite: true });")).toBe(0);
});

test("the judge sees a temp name with .tmp in the middle, or concatenated on", () => {
  // 0.7.1's first guard matched only a literal ENDING in `.tmp`, so these
  // two passed it (dream-engine mutated back to the first; alert-watchdog
  // shipped the second).
  expect(derivedTempSites("const t = `${path}.tmp-${process.pid}`;")).toBe(1);
  expect(derivedTempSites("const t = `${path}.tmp-${process.pid}-${Date.now()}`;")).toBe(1);
  expect(derivedTempSites('const t = path + ".tmp";')).toBe(1);
  expect(derivedTempSites("const t = file + '.tmp-' + process.pid;")).toBe(1);
  expect(derivedTempSites('if (name.endsWith(".tmp")) continue;')).toBe(0);
});

test("the append judge counts raw appends, not seams, declarations or comments", () => {
  expect(rawAppendSites("appendFileSync(path, line, { mode: 0o600 });")).toBe(1);
  expect(rawAppendSites("await appendFile(FILE, line);")).toBe(1);
  expect(rawAppendSites("fs.appendFileSync(p, x);")).toBe(1);
  expect(rawAppendSites("deps.fs.appendFile(p, x);")).toBe(0);
  expect(rawAppendSites("  appendFile(path: string, text: string): void;")).toBe(0);
  expect(rawAppendSites("// appendFileSync(p, x) in a comment\n * appendFileSync(q)")).toBe(0);
  expect(rawAppendSites("appendContained(root, rel, line, { mode: 0o600 });")).toBe(0);
  expect(rawAppendSites('import { appendFileSync, existsSync } from "node:fs";')).toBe(0);
});

/**
 * Every site `judge` finds in the tree, against `list`: an unlisted site, or
 * more sites than listed, fails; so does an entry whose count no longer
 * matches, unless it is pending elsewhere and has fallen.
 */
function checkAgainst(
  judge: (source: string) => number,
  list: Readonly<Record<string, Exemption>>,
): { files: number; found: Map<string, number>; unlisted: string[]; stale: string[] } {
  const files = trackedSources();
  const found = new Map<string, number>();
  for (const file of files) {
    const n = judge(readFileSync(join(ROOT, file), "utf8"));
    if (n > 0) found.set(file, n);
  }
  const unlisted = [...found.entries()]
    .filter(([file, n]) => list[file] === undefined || n > (list[file]?.sites ?? 0))
    .map(([file, n]) => `${file}: ${n}`);
  const stale = Object.entries(list)
    .filter(([file, e]) => {
      const n = found.get(file) ?? 0;
      return e.pendingElsewhere === true ? n > e.sites : n !== e.sites;
    })
    .map(([file, e]) => `${file}: listed ${e.sites}, found ${found.get(file) ?? 0}`);
  return { files: files.length, found, unlisted, stale };
}

test("no write goes through a temp name derived from its target, unless listed with its reason", () => {
  const { files, found, unlisted, stale } = checkAgainst(derivedTempSites, EXEMPT);
  expect(unlisted).toEqual([]);
  // The list is checked as well: a fixed file must leave it.
  expect(stale).toEqual([]);
  // Hit count: the scan read the whole tree and found the listed sites.
  expect(files).toBeGreaterThan(1000);
  expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20);
});

test("no append goes through a link at its file, unless listed with its reason", () => {
  const { files, found, unlisted, stale } = checkAgainst(rawAppendSites, APPEND_EXEMPT);
  expect(unlisted).toEqual([]);
  expect(stale).toEqual([]);
  expect(files).toBeGreaterThan(1000);
  expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20);
});
