/**
 * The libraries under `src/lib`, tested on their own, because each one holds
 * a distinction the tools are built on and a tool-level test would only show
 * it indirectly:
 *
 *   - which freshness states are VERDICTS and which are not,
 *   - which condition a store file is in, as opposed to what it contains,
 *   - what a hook declaration PARSES to, as opposed to how it is spelled,
 *   - which machine-wide file each root resolves to,
 *   - which environment variables a spawned compile can see.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type { BundleFreshness } from "@crewhaus/harness-supervisor";
import { classify, spawnEnv } from "./lib/bundle";
import { countByState, filterJobs, probeLedger, sortJobs } from "./lib/jobs";
import { mutationBlockedBy, probeRegistryFile } from "./lib/registry";
import { probeName } from "./lib/result";
import { jobLedgerPath, registryFilePath, resolveHangarRoot } from "./lib/roots";
import {
  managerBlock,
  parseDeclaration,
  probeCommand,
  probeSettings,
  splitWarning,
  withHook,
} from "./lib/settings";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-fleet-lib-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const freshness = (state: BundleFreshness["state"], exact = false): BundleFreshness => ({
  state,
  exact,
  label: `label for ${state}`,
});

// ---------------------------------------------------------------------------
// freshness → verdict
// ---------------------------------------------------------------------------

test("every freshness state maps to exactly one verdict, and neither unknown state is fresh", () => {
  const mapped = (
    ["fresh", "stale", "approximate-fresh", "approximate-stale", "unstamped", "unknown"] as const
  ).map((state) => ({ state, ...classify(freshness(state)) }));
  console.log(
    `VERDICTS ${JSON.stringify(mapped.map((m) => [m.state, m.verdict, m.wouldRecompile]))}`,
  );
  expect(mapped.map((m) => m.verdict)).toEqual([
    "fresh",
    "stale",
    "fresh",
    "stale",
    // The two that a caller must never read as "the bundle is current".
    "undetermined",
    "undetermined",
  ]);
  // And the prediction of what compileIfStale would do: NOT the same set as
  // "not fresh", which is the whole trap — an undetermined bundle is never
  // recompiled by it, so reporting its success as freshness is a lie.
  expect(mapped.filter((m) => m.wouldRecompile).map((m) => m.state)).toEqual([
    "stale",
    "approximate-stale",
  ]);
});

test("classify carries the library's own exactness and stamp through untouched", () => {
  const view = classify({ ...freshness("fresh", true), compiledWith: "0.6.0" });
  expect(view).toEqual({
    state: "fresh",
    verdict: "fresh",
    exact: true,
    label: "label for fresh",
    wouldRecompile: false,
    compiledWith: "0.6.0",
  });
  // An approximate verdict says so, so a caller can tell a proven answer
  // from a mtime guess.
  expect(classify(freshness("approximate-fresh")).exact).toBe(false);
});

// ---------------------------------------------------------------------------
// the machine roots
// ---------------------------------------------------------------------------

test("the machine roots come from the environment, and the hangar root nests under the registry root", () => {
  const env = { CREWHAUS_REGISTRY_ROOT: "/srv/reg" };
  expect(registryFilePath(env)).toBe(path.join("/srv/reg", "harnesses.json"));
  // The rule mirrored from apps/cli's resolveHangarRoot: an explicit root
  // wins, otherwise <registryRoot>/hangar. If the app ever changes it, this
  // is the test that fails.
  expect(resolveHangarRoot(env)).toBe(path.join("/srv/reg", "hangar"));
  expect(jobLedgerPath(env)).toBe(path.join("/srv/reg", "hangar", "jobs.jsonl"));
  expect(resolveHangarRoot({ ...env, CREWHAUS_HANGAR_ROOT: "/srv/hangar" })).toBe("/srv/hangar");
  // No env at all: the documented default, under the home directory.
  expect(registryFilePath({})).toBe(path.join(homedir(), ".crewhaus", "harnesses.json"));
});

// ---------------------------------------------------------------------------
// store conditions
// ---------------------------------------------------------------------------

test("probeRegistryFile keeps absent, unparseable and not-a-file apart", () => {
  const file = path.join(tmp, "harnesses.json");
  expect(probeRegistryFile(file).state).toBe("absent");

  writeFileSync(file, '{"v":2,"harnesses":[{"id":"hrn_00000000000000aa"}],"groups":[]}');
  const ok = probeRegistryFile(file);
  expect(ok.state).toBe("ok");
  // The RAW row count, so "the file has rows but the API returned none" is
  // visible rather than invisible.
  expect(ok.rawHarnessCount).toBe(1);

  writeFileSync(file, "[1,2,3]");
  expect(probeRegistryFile(file).state).toBe("unparseable");
  writeFileSync(file, "{oops");
  expect(probeRegistryFile(file).state).toBe("unparseable");

  const asDir = path.join(tmp, "dir-registry");
  mkdirSync(asDir);
  expect(probeRegistryFile(asDir).state).toBe("not-a-file");
});

test("only an absent or parsed registry lets a mutation through", () => {
  const codes = (["absent", "ok", "unparseable", "not-a-file", "unreadable"] as const).map(
    (state) => {
      const blocked = mutationBlockedBy({ state, path: "/x" });
      return [state, blocked.ok ? "allowed" : blocked.code];
    },
  );
  console.log(`MUTATION_GATE ${JSON.stringify(codes)}`);
  expect(codes).toEqual([
    ["absent", "allowed"],
    ["ok", "allowed"],
    ["unparseable", "refused"],
    ["not-a-file", "unreadable"],
    ["unreadable", "unreadable"],
  ]);
  const refused = mutationBlockedBy({ state: "unparseable", path: "/x", detail: "not valid JSON" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    // The reason has to name what would happen, not just say no: the write
    // that follows is the one that would replace every row in the file.
    expect(refused.reason).toContain("heals it on the next write");
    expect(refused.reason).toContain("not an empty registry");
  }
});

test("probeLedger and probeName answer absent and unreadable differently", () => {
  const ledger = path.join(tmp, "jobs.jsonl");
  expect(probeLedger(ledger).state).toBe("absent");
  writeFileSync(ledger, '{"jobId":"a"}\n');
  const ok = probeLedger(ledger);
  expect(ok.state).toBe("ok");
  expect(ok.bytes).toBe(14);

  // A dangling symlink: `existsSync` says false (it follows the link), and
  // that is exactly the case that must not read as "there is nothing here".
  const dangling = path.join(tmp, "dangling");
  symlinkSync(path.join(tmp, "nowhere"), dangling);
  const probed = probeName("dangling", dangling);
  expect(probed.ok && probed.value).toBe("symlink");
});

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

const record = (fields: Record<string, unknown>) =>
  ({
    jobId: "j",
    harnessDir: "/h",
    kind: "eval",
    argv: [],
    mutating: true,
    state: "done",
    enqueuedAt: "2026-09-01T00:00:00.000Z",
    ...fields,
  }) as never;

test("filterJobs compares parsed instants, not spelled timestamps", () => {
  const records = [
    record({ jobId: "a", enqueuedAt: "2026-09-01T10:00:00+02:00" }),
    record({ jobId: "b", enqueuedAt: "2026-09-01T09:30:00.000Z" }),
  ];
  // 08:00Z and 09:30Z. A string comparison against "2026-09-01T09:00:00Z"
  // would keep "2026-09-01T10:00:00+02:00" (it sorts later as text) even
  // though that instant is 08:00Z and is EARLIER.
  const { kept } = filterJobs(records, { sinceIso: "2026-09-01T09:00:00Z" });
  console.log(`SINCE ${JSON.stringify(kept.map((r) => r.jobId))}`);
  expect(kept.map((r) => r.jobId)).toEqual(["b"]);
});

test("filterJobs keeps a record whose timestamp cannot be parsed and names it", () => {
  const { kept, unparsedTimestamps } = filterJobs(
    [record({ jobId: "bad", enqueuedAt: "whenever" }), record({ jobId: "good" })],
    { sinceIso: "2026-01-01T00:00:00Z" },
  );
  expect(kept.map((r) => r.jobId).sort()).toEqual(["bad", "good"]);
  expect(unparsedTimestamps).toEqual(["bad"]);
});

test("sortJobs is newest first and stable on a tie", () => {
  const records = [
    record({ jobId: "b", enqueuedAt: "2026-09-01T00:00:00.000Z" }),
    record({ jobId: "a", enqueuedAt: "2026-09-01T00:00:00.000Z" }),
    record({ jobId: "c", enqueuedAt: "2026-09-02T00:00:00.000Z" }),
  ];
  expect(sortJobs(records).map((r) => r.jobId)).toEqual(["c", "a", "b"]);
  expect(countByState([record({ state: "interrupted" }), record({ state: "done" })])).toEqual({
    done: 1,
    interrupted: 1,
  });
});

// ---------------------------------------------------------------------------
// hook declarations
// ---------------------------------------------------------------------------

test("a string declaration is ONE command, and a spaced one is refused by its ARGV", () => {
  const single = parseDeclaration("prep.sh");
  expect(single.ok && single.value.argv).toEqual(["prep.sh"]);
  expect(splitWarning(["prep.sh"])).toBeUndefined();

  const spaced = parseDeclaration("bun run prep.ts");
  // The supervisor's parser does not split it — this is the whole point.
  expect(spaced.ok && spaced.value.argv).toEqual(["bun run prep.ts"]);
  const warning = splitWarning(spaced.ok ? spaced.value.argv : []);
  console.log(`SPLIT_WARNING ${warning}`);
  expect(warning).toContain('["bun", "run", "prep.ts"]');
  // An ARRAY of the same words is fine: it is already an argv vector.
  expect(splitWarning(["bun", "run", "prep.ts"])).toBeUndefined();
});

test("a declaration the supervisor's parser drops is reported as no hook at all", () => {
  for (const value of ["   ", [] as string[], [""] as string[]]) {
    const parsed = parseDeclaration(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("silently NO hook");
  }
});

test("probeCommand separates executable, not-executable, absent and left-to-the-OS", () => {
  const script = path.join(tmp, "prep.sh");
  writeFileSync(script, "#!/bin/sh\n");
  chmodSync(script, 0o644);
  expect(probeCommand(script).state).toBe("not-executable");
  chmodSync(script, 0o755);
  expect(probeCommand(script).state).toBe("executable");
  expect(probeCommand(path.join(tmp, "nope.sh")).state).toBe("absent");
  // A bare name is resolved by whichever process spawns the hook, which is
  // not this one — "absent" would be a guess.
  expect(probeCommand("bun").state).toBe("path-lookup");
});

test("withHook replaces one key and preserves everything else in the document", () => {
  const doc = {
    permissions: { allow: ["Read(*)"] },
    hooks: [{ event: "pre-tool" }],
    manager: { autoCompile: true, hooks: { preSpawn: "./a.sh", timeoutMs: 42 } },
  };
  const manager = managerBlock(doc);
  expect(manager.ok).toBe(true);
  if (!manager.ok) return;
  const next = withHook(doc, manager.value, "postCompile", ["./b.sh"], 99);
  expect(next["permissions"]).toEqual({ allow: ["Read(*)"] });
  expect(next["hooks"]).toEqual([{ event: "pre-tool" }]);
  expect(next["manager"]).toEqual({
    autoCompile: true,
    hooks: { preSpawn: "./a.sh", postCompile: ["./b.sh"], timeoutMs: 99 },
  });
  // Removal deletes the KEY rather than setting it to undefined: the two are
  // the same on read and different on write, and JSON keeps only one of them.
  const removed = withHook(doc, manager.value, "preSpawn", undefined);
  expect(Object.keys((removed["manager"] as { hooks: object }).hooks)).toEqual(["timeoutMs"]);
});

test("a manager key of the wrong type is refused rather than overwritten", () => {
  expect(managerBlock({ manager: ["oops"] }).ok).toBe(false);
  expect(managerBlock({ manager: "oops" }).ok).toBe(false);
  expect(managerBlock({}).ok).toBe(true);
});

test("probeSettings reports the file's mode so a rewrite can keep it", () => {
  const file = path.join(tmp, "settings.json");
  writeFileSync(file, "{}");
  chmodSync(file, 0o640);
  const probe = probeSettings(file, "settings.json");
  expect(probe.state).toBe("ok");
  expect(probe.mode).toBe(0o640);
});

// ---------------------------------------------------------------------------
// the environment a compile gets
// ---------------------------------------------------------------------------

test("spawnEnv forwards a minimal base plus the names it was given, and nothing else", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    ANTHROPIC_API_KEY: "sk-secret",
    NPM_TOKEN: "npm-secret",
    WANTED: "yes",
    ABSENT: undefined,
  };
  const { env, forwarded } = spawnEnv(["WANTED", "ABSENT"], source);
  console.log(`SPAWN_ENV ${JSON.stringify(Object.keys(env).sort())}`);
  expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "WANTED"]);
  // A name with no value is not reported as forwarded — the report is about
  // what the child actually received.
  expect(forwarded).toEqual(["WANTED"]);
  expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  expect(env["NPM_TOKEN"]).toBeUndefined();
});
