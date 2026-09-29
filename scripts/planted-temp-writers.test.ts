/**
 * A write-then-rename through a temp whose name is derived from the target
 * (`${path}.tmp`, `${path}.${process.pid}.tmp`) is a planted-link hole: a
 * symlink put at that name beforehand, dangling or not, is followed by the
 * write, so the bytes land wherever the link points, and the rename then puts
 * the link in place of the file. A model can plant one without a shell: Grep
 * finds the name and a GitApplyPatch patch creates the link. 0.7.0's session
 * store, approvals log, settings write-back, routing scoreboard, dream state,
 * prompt-cache record, optimize write-back and DEK store all did this; 0.7.1
 * moved them to @crewhaus/tool-safety/fs (`writeFileSafe`: a random temp opened
 * O_EXCL|O_NOFOLLOW, a leaf check, the rename).
 *
 * This guard finds every derived temp name in non-test source (a template
 * literal ending in `.tmp`, outside comments) and fails on any site not listed
 * below with its reason. The list is checked too: an entry whose file no longer
 * has that many sites fails, so a fixed writer drops out of it, except entries
 * another 0.7.1 unit is fixing in parallel, which may reach zero.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);

type Exemption = {
  /** Derived temp names in this file that the reason covers. */
  readonly sites: number;
  readonly reason: string;
  /** Being fixed by another 0.7.1 unit; the count may fall to zero. */
  readonly pendingElsewhere?: true;
};

const HOME = "writes under ~/.crewhaus, which no model tool can write to";
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
  "packages/tool-secrets/src/lib/write.ts": {
    sites: 1,
    reason:
      'opened with flag "wx" (O_CREAT|O_EXCL), which fails on any existing name, a link included',
  },
  "packages/watchme-store/src/registry.ts": { sites: 1, reason: `the watchme registry; ${HOME}` },
  "packages/watchme-store/src/store.ts": { sites: 2, reason: `watchme observations; ${HOME}` },
};

/** Derived temp names on non-comment lines, per file. */
function derivedTempSites(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const code = line.trimStart();
    if (code.startsWith("*") || code.startsWith("/*") || code.startsWith("//")) continue;
    count += (code.match(/`[^`]*\.tmp`/g) ?? []).length;
  }
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
      .filter((f) => f !== "" && !f.endsWith(".test.ts"))
      // The safe writer itself names its random temps.
      .filter((f) => !f.startsWith("packages/tool-safety/"))
  );
}

test("the judge counts code, not comments", () => {
  expect(derivedTempSites("const t = `${p}.tmp`;\n// `${p}.tmp` in a comment\n * `x.tmp`")).toBe(1);
  expect(derivedTempSites("const a = `${p}.${pid}.tmp`, b = `${q}.tmp`;")).toBe(2);
  expect(derivedTempSites("writeFileSafe(root, rel, data, { overwrite: true });")).toBe(0);
});

test("no write goes through a temp name derived from its target, unless listed with its reason", () => {
  const files = trackedSources();
  const found = new Map<string, number>();
  for (const file of files) {
    const n = derivedTempSites(readFileSync(join(ROOT, file), "utf8"));
    if (n > 0) found.set(file, n);
  }
  const unlisted = [...found.entries()]
    .filter(([file, n]) => EXEMPT[file] === undefined || n > (EXEMPT[file]?.sites ?? 0))
    .map(([file, n]) => `${file}: ${n}`);
  expect(unlisted).toEqual([]);
  // The list is checked as well: a fixed file must leave it.
  const stale = Object.entries(EXEMPT)
    .filter(([file, e]) => {
      const n = found.get(file) ?? 0;
      return e.pendingElsewhere === true ? n > e.sites : n !== e.sites;
    })
    .map(([file, e]) => `${file}: listed ${e.sites}, found ${found.get(file) ?? 0}`);
  expect(stale).toEqual([]);
  // Hit count: the scan read the whole tree and found the listed sites.
  expect(files.length).toBeGreaterThan(1000);
  expect([...found.keys()].filter((f) => EXEMPT[f] === undefined)).toEqual([]);
});
