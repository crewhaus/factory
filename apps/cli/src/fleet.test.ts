import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "@crewhaus/spec-registry";
import { buildFeedbackRecord } from "./feedback";
import {
  type BuildInventoryDeps,
  FleetError,
  type HarnessHealth,
  type LastEvalEntry,
  buildFleetInventory,
  buildHarnessHealth,
  countFeedback,
  countOpenIncidents,
  countSessions,
  describeFleetExit,
  discoverHarnesses,
  fleetSelfInvokeArgv,
  formatBulkReport,
  formatHealth,
  formatInventory,
  healthMark,
  isCompiledEntryPath,
  lastEvalFor,
  matchesFilter,
  readSpecHeader,
  resolveBulkCommand,
  runFleetBulk,
} from "./fleet";

/** A valid feedback JSONL line for (session, turn). */
function fbLine(turn: number, thumbs: "up" | "down"): string {
  return JSON.stringify(
    buildFeedbackRecord({
      id: `fb_${turn}_${thumbs}`,
      sessionId: "sess_00112233aabbccdd",
      turnNumber: turn,
      ts: "2026-07-01T00:00:00.000Z",
      source: "cli",
      thumbs,
    }),
  );
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-fleet-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Seed a harness dir under root with a spec + optional state. */
function seedHarness(
  rel: string,
  opts: {
    spec?: string;
    sessions?: string[];
    feedbackLines?: string[];
    incidents?: string[];
    audit?: boolean;
  } = {},
): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  if (opts.spec !== undefined) writeFileSync(join(dir, "crewhaus.yaml"), opts.spec);
  const sessionsDir = join(dir, ".crewhaus", "sessions");
  if (opts.sessions !== undefined) {
    mkdirSync(sessionsDir, { recursive: true });
    for (const id of opts.sessions) {
      writeFileSync(join(sessionsDir, `${id}.json`), "{}");
    }
  }
  if (opts.feedbackLines !== undefined) {
    const fbDir = join(dir, ".crewhaus", "feedback");
    mkdirSync(fbDir, { recursive: true });
    writeFileSync(join(fbDir, "restored.jsonl"), `${opts.feedbackLines.join("\n")}\n`);
  }
  if (opts.incidents !== undefined) {
    const incDir = join(dir, ".crewhaus", "incidents");
    mkdirSync(incDir, { recursive: true });
    for (const f of opts.incidents) writeFileSync(join(incDir, f), "{}");
  }
  if (opts.audit === true) {
    mkdirSync(join(dir, ".crewhaus", "audit"), { recursive: true });
  }
  return dir;
}

const CLI_SPEC = `name: concierge
version: 1
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: help
`;

const WORKFLOW_SPEC = `name: nightly
version: 1
target: workflow
model: claude-opus-4-1
`;

/** Deps that return no registry entries / no eval history (empty harness). */
function emptyDeps(): BuildInventoryDeps {
  return {
    readManifest: async () => undefined,
    readEvalIndex: () => [],
  };
}

describe("readSpecHeader", () => {
  test("reads name/target and agent.model for a cli spec", () => {
    expect(readSpecHeader(CLI_SPEC)).toEqual({
      name: "concierge",
      target: "cli",
      model: "claude-sonnet-4-5",
    });
  });

  test("reads top-level model for a workflow spec", () => {
    expect(readSpecHeader(WORKFLOW_SPEC)).toEqual({
      name: "nightly",
      target: "workflow",
      model: "claude-opus-4-1",
    });
  });

  test("strips quotes and inline comments", () => {
    const h = readSpecHeader('name: "My Bot" # the bot\ntarget: channel\n');
    expect(h.name).toBe("My Bot");
    expect(h.target).toBe("channel");
  });

  test("tolerates a spec missing fields", () => {
    expect(readSpecHeader("version: 1\n")).toEqual({});
  });
});

describe("discoverHarnesses", () => {
  test("finds every dir with a crewhaus.yaml, sorted", () => {
    seedHarness("bot", { spec: CLI_SPEC });
    seedHarness("nested/optimizer", { spec: WORKFLOW_SPEC });
    seedHarness("no-spec-here", {}); // no spec → not a harness
    const found = discoverHarnesses(root);
    expect(found.map((h) => h.dir)).toEqual([join(root, "bot"), join(root, "nested/optimizer")]);
  });

  test("does not descend into .crewhaus or node_modules", () => {
    const dir = seedHarness("bot", { spec: CLI_SPEC });
    // A bundled template spec that must NOT count as a fleet member.
    mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "some-pkg", "crewhaus.yaml"), CLI_SPEC);
    mkdirSync(join(dir, ".crewhaus", "cache"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "cache", "crewhaus.yaml"), CLI_SPEC);
    const found = discoverHarnesses(root);
    expect(found.map((h) => h.dir)).toEqual([join(root, "bot")]);
  });

  test("counts the root itself when it carries a spec", () => {
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const found = discoverHarnesses(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.dir).toBe(root);
  });

  test("throws FleetError on a missing root", () => {
    expect(() => discoverHarnesses(join(root, "nope"))).toThrow(FleetError);
  });
});

describe("state counters", () => {
  test("countSessions counts only sess_<hex>.json files", () => {
    const dir = seedHarness("bot", {
      spec: CLI_SPEC,
      sessions: ["sess_00112233aabbccdd", "sess_ffeeddccbbaa0099"],
    });
    // a non-session json must not count
    writeFileSync(join(dir, ".crewhaus", "sessions", "notes.json"), "{}");
    expect(countSessions(dir)).toBe(2);
  });

  test("countSessions is 0 with no sessions dir", () => {
    const dir = seedHarness("bot", { spec: CLI_SPEC });
    expect(countSessions(dir)).toBe(0);
  });

  test("countFeedback dedupes by (session,turn) like distill", () => {
    const dir = seedHarness("bot", {
      spec: CLI_SPEC,
      // two records for turn 1 collapse to one distinct record
      feedbackLines: [fbLine(1, "up"), fbLine(1, "up"), fbLine(2, "down")],
    });
    expect(countFeedback(dir)).toBe(2);
  });

  test("countOpenIncidents ignores resolved incidents", () => {
    const dir = seedHarness("bot", {
      spec: CLI_SPEC,
      incidents: ["inc_1.json", "inc_2.resolved.json", "inc_3.json"],
    });
    expect(countOpenIncidents(dir)).toBe(2);
  });
});

describe("lastEvalFor", () => {
  test("picks the newest run by ts", () => {
    const entries: LastEvalEntry[] = [
      { datasetName: "smoke", passRate: 0.5, ts: "2026-06-01T00:00:00Z" },
      { datasetName: "smoke", passRate: 0.9, ts: "2026-07-01T00:00:00Z" },
      { datasetName: "smoke", passRate: 0.7, ts: "2026-06-15T00:00:00Z" },
    ];
    expect(lastEvalFor(entries)?.passRate).toBe(0.9);
  });

  test("undefined for an empty index", () => {
    expect(lastEvalFor([])).toBeUndefined();
  });
});

describe("buildFleetInventory", () => {
  test("aggregates spec header, registry, eval, sessions, feedback", async () => {
    seedHarness("bot", {
      spec: CLI_SPEC,
      sessions: ["sess_00112233aabbccdd"],
      feedbackLines: [fbLine(1, "up")],
    });
    const manifest: Manifest = { versions: ["v1", "v2"], pins: { prod: "v1" } };
    const deps: BuildInventoryDeps = {
      readManifest: async (name) => (name === "concierge" ? manifest : undefined),
      readEvalIndex: () => [{ datasetName: "smoke", passRate: 0.8, ts: "2026-07-01T00:00:00Z" }],
    };
    const rows = await buildFleetInventory(root, deps);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.specName).toBe("concierge");
    expect(r?.header.target).toBe("cli");
    expect(r?.registry.latestVersion).toBe("v2");
    expect(r?.registry.pins).toEqual({ prod: "v1" });
    expect(r?.lastEval?.passRate).toBe(0.8);
    expect(r?.sessionCount).toBe(1);
    expect(r?.feedbackCount).toBe(1);
    expect(r?.specUnreadable).toBe(false);
  });

  test("degrades gracefully for an unregistered, empty harness", async () => {
    seedHarness("fresh", { spec: WORKFLOW_SPEC });
    const rows = await buildFleetInventory(root, emptyDeps());
    const r = rows[0];
    expect(r?.registry.latestVersion).toBeUndefined();
    expect(r?.lastEval).toBeUndefined();
    expect(r?.sessionCount).toBe(0);
    expect(r?.feedbackCount).toBe(0);
  });

  test("falls back to dir basename when the spec has no name", async () => {
    seedHarness("anon", { spec: "target: cli\n" });
    const rows = await buildFleetInventory(root, emptyDeps());
    expect(rows[0]?.specName).toBe("anon");
  });

  test("formatInventory renders a non-empty table", async () => {
    seedHarness("bot", { spec: CLI_SPEC });
    const rows = await buildFleetInventory(root, emptyDeps());
    const lines = formatInventory(rows, root).join("\n");
    expect(lines).toContain("concierge");
    expect(lines).toContain("shape=cli");
    expect(lines).toContain("unregistered");
  });

  test("formatInventory reports an empty fleet", () => {
    expect(formatInventory([], root).join("\n")).toContain("no harnesses");
  });
});

describe("health rollup", () => {
  test("healthy when registered, eval ok, no incidents", async () => {
    seedHarness("bot", { spec: CLI_SPEC, audit: true });
    const manifest: Manifest = { versions: ["v1"], pins: { prod: "v1" } };
    const rows = await buildFleetInventory(root, {
      readManifest: async () => manifest,
      readEvalIndex: () => [],
    });
    const health = await buildHarnessHealth(rows[0] as never, () => ({
      healthy: true,
      note: "baseline held",
    }));
    expect(healthMark(health)).toBe("✓");
    expect(health.hasAudit).toBe(true);
  });

  test("attention when an incident is open", async () => {
    seedHarness("bot", { spec: CLI_SPEC, incidents: ["inc_1.json"] });
    const rows = await buildFleetInventory(root, emptyDeps());
    const health = await buildHarnessHealth(rows[0] as never, () => ({
      healthy: true,
      note: "ok",
    }));
    expect(health.openIncidents).toBe(1);
    expect(healthMark(health)).toBe("✗");
  });

  test("attention when eval regressed", () => {
    const h: HarnessHealth = {
      dir: "/x",
      specName: "bot",
      registered: true,
      pinnedEnvs: [],
      evalHealthy: false,
      evalNote: "pass rate dropped",
      openIncidents: 0,
      hasAudit: false,
    };
    expect(healthMark(h)).toBe("✗");
  });

  test("attention when a pin points at nothing registered", () => {
    const h: HarnessHealth = {
      dir: "/x",
      specName: "bot",
      registered: false,
      pinnedEnvs: ["prod"],
      evalHealthy: true,
      evalNote: "ok",
      openIncidents: 0,
      hasAudit: false,
    };
    expect(healthMark(h)).toBe("✗");
  });

  test("formatHealth summarizes attention count", () => {
    const rows: HarnessHealth[] = [
      {
        dir: "/a",
        specName: "a",
        registered: true,
        pinnedEnvs: [],
        evalHealthy: true,
        evalNote: "ok",
        openIncidents: 0,
        hasAudit: false,
      },
      {
        dir: "/b",
        specName: "b",
        registered: true,
        pinnedEnvs: [],
        evalHealthy: false,
        evalNote: "dropped",
        openIncidents: 0,
        hasAudit: false,
      },
    ];
    const out = formatHealth(rows, root).join("\n");
    expect(out).toContain("1 harness(es) need attention");
  });
});

describe("resolveBulkCommand", () => {
  test("resolves single-token read-only commands", () => {
    expect(resolveBulkCommand(["doctor"], false)).toEqual({ argv: ["doctor"], mutating: false });
  });

  test("resolves two-token commands (security digest) with trailing args", () => {
    expect(resolveBulkCommand(["security", "digest", "--since", "7d"], false)).toEqual({
      argv: ["security", "digest", "--since", "7d"],
      mutating: false,
    });
  });

  test("refuses a mutating command without --allow-mutating", () => {
    expect(() => resolveBulkCommand(["optimize"], false)).toThrow(FleetError);
  });

  test("permits a mutating command with --allow-mutating", () => {
    expect(resolveBulkCommand(["optimize", "--write-back"], true)).toEqual({
      argv: ["optimize", "--write-back"],
      mutating: true,
    });
  });

  test("throws on an empty subcommand", () => {
    expect(() => resolveBulkCommand([], false)).toThrow(FleetError);
  });
});

describe("isCompiledEntryPath", () => {
  test("detects the POSIX standalone-binary sentinel", () => {
    expect(isCompiledEntryPath("/$bunfs/root/crewhaus-macos-arm64-0.2.4")).toBe(true);
  });
  test("detects the Windows standalone-binary sentinel", () => {
    expect(isCompiledEntryPath("B:\\~BUN\\root\\crewhaus-windows-x64-0.2.4.exe")).toBe(true);
  });
  test("a real dev script path is not compiled", () => {
    expect(isCompiledEntryPath("/Users/me/factory/apps/cli/src/index.ts")).toBe(false);
  });
});

describe("fleetSelfInvokeArgv", () => {
  // The v0.2.4 fleet-run bug: a compiled binary re-injects its own `/$bunfs/…`
  // entry, so passing that entry as an arg made the child read it as the
  // subcommand (`unknown subcommand: /$bunfs/root/crewhaus-…`). The compiled
  // branch must therefore OMIT the entry and let Bun supply it.
  test("compiled binary: drops the bunfs entry, passes only exe + child argv", () => {
    expect(
      fleetSelfInvokeArgv(
        {
          execPath: "/usr/local/bin/crewhaus",
          entryPath: "/$bunfs/root/crewhaus-macos-arm64-0.2.4",
        },
        ["doctor"],
      ),
    ).toEqual(["/usr/local/bin/crewhaus", "doctor"]);
  });
  test("compiled binary: preserves multi-token subcommands + trailing flags", () => {
    expect(
      fleetSelfInvokeArgv(
        {
          execPath: "/usr/local/bin/crewhaus",
          entryPath: "/$bunfs/root/crewhaus-macos-arm64-0.2.4",
        },
        ["security", "digest", "--since", "7d"],
      ),
    ).toEqual(["/usr/local/bin/crewhaus", "security", "digest", "--since", "7d"]);
  });
  test("dev process: keeps the script path so `bun <script> <argv>` resolves", () => {
    expect(
      fleetSelfInvokeArgv(
        {
          execPath: "/Users/me/.bun/bin/bun",
          entryPath: "/Users/me/factory/apps/cli/src/index.ts",
        },
        ["doctor"],
      ),
    ).toEqual(["/Users/me/.bun/bin/bun", "/Users/me/factory/apps/cli/src/index.ts", "doctor"]);
  });
});

describe("matchesFilter", () => {
  const inv = {
    dir: "/root/slack-bot",
    specName: "concierge",
    header: {},
    registry: { pins: {} },
    sessionCount: 0,
    feedbackCount: 0,
    specUnreadable: false,
  };
  test("undefined filter matches all", () => {
    expect(matchesFilter(inv as never, undefined)).toBe(true);
  });
  test("matches on spec name", () => {
    expect(matchesFilter(inv as never, "conc*")).toBe(true);
  });
  test("matches on dir basename", () => {
    expect(matchesFilter(inv as never, "*bot*")).toBe(true);
  });
  test("non-match returns false", () => {
    expect(matchesFilter(inv as never, "optimizer")).toBe(false);
  });
});

describe("runFleetBulk", () => {
  test("runs a read-only command across matched harnesses via the injected runner", async () => {
    seedHarness("bot-a", { spec: CLI_SPEC });
    seedHarness("bot-b", { spec: WORKFLOW_SPEC.replace("nightly", "bot-b") });
    const calls: Array<{ cwd: string; argv: readonly string[] }> = [];
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["doctor"],
      allowMutating: false,
      deps: emptyDeps(),
      runner: async ({ cwd, argv }) => {
        calls.push({ cwd, argv });
        return { exitCode: cwd.endsWith("bot-b") ? 1 : 0, tail: "done" };
      },
      confirm: async () => true,
    });
    expect(calls).toHaveLength(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(0);
  });

  test("filter skips non-matching harnesses", async () => {
    seedHarness("slack-bot", { spec: CLI_SPEC });
    seedHarness("optimizer", { spec: WORKFLOW_SPEC });
    let ran = 0;
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["doctor"],
      filter: "*bot*",
      allowMutating: false,
      deps: emptyDeps(),
      runner: async () => {
        ran += 1;
        return { exitCode: 0, tail: "" };
      },
      confirm: async () => true,
    });
    expect(ran).toBe(1);
    expect(report.skipped).toBe(1);
  });

  test("mutating command runs only confirmed harnesses", async () => {
    seedHarness("bot-yes", { spec: CLI_SPEC });
    seedHarness("bot-no", { spec: WORKFLOW_SPEC.replace("nightly", "bot-no") });
    const ranDirs: string[] = [];
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["optimize"],
      allowMutating: true,
      deps: emptyDeps(),
      runner: async ({ cwd }) => {
        ranDirs.push(cwd);
        return { exitCode: 0, tail: "" };
      },
      confirm: async (inv) => inv.dir.endsWith("bot-yes"),
    });
    expect(ranDirs).toHaveLength(1);
    expect(ranDirs[0]?.endsWith("bot-yes")).toBe(true);
    expect(report.skipped).toBe(1);
    expect(report.plan.mutating).toBe(true);
  });

  test("formatBulkReport renders marks + summary", async () => {
    seedHarness("bot", { spec: CLI_SPEC });
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["doctor"],
      allowMutating: false,
      deps: emptyDeps(),
      runner: async () => ({ exitCode: 0, tail: "green" }),
      confirm: async () => true,
    });
    const out = formatBulkReport(report).join("\n");
    expect(out).toContain("✓ concierge");
    expect(out).toContain("1 passed, 0 failed, 0 skipped");
  });

  test("describeFleetExit decodes the documented EXIT_CODES table (0.3.0 Goal 6)", () => {
    expect(describeFleetExit(31)).toEqual({
      class: "billing",
      title: "provider account out of funding",
    });
    expect(describeFleetExit(30)).toEqual({
      class: "auth",
      title: "provider rejected the credentials",
    });
    expect(describeFleetExit(1)).toEqual({ class: "unknown", title: "unclassified failure" });
    // 0 is success and unmapped codes stay plain.
    expect(describeFleetExit(0)).toBeUndefined();
    expect(describeFleetExit(77)).toBeUndefined();
  });

  test("formatBulkReport renders the failure title + class rollup for coded exits (0.3.0 Goal 6)", async () => {
    seedHarness("support-bot", { spec: CLI_SPEC.replace("concierge", "support-bot") });
    seedHarness("concierge", { spec: CLI_SPEC });
    const codes = new Map<string, number>([
      ["support-bot", 31],
      ["concierge", 0],
    ]);
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["doctor"],
      allowMutating: false,
      deps: emptyDeps(),
      runner: async ({ cwd }) => ({
        exitCode: codes.get(cwd.split("/").pop() ?? "") ?? 77,
        tail: "",
      }),
      confirm: async () => true,
    });
    const out = formatBulkReport(report).join("\n");
    // The coded exit renders the design §8.2 shape:
    expect(out).toContain("✗ support-bot — provider account out of funding · exit 31");
    expect(out).toContain("✓ concierge — exit 0");
    // …and the summary rolls failures up by class.
    expect(out).toContain("1 passed, 1 failed (billing ×1), 0 skipped");
  });

  test("formatBulkReport keeps the plain exit line for unmapped codes", async () => {
    seedHarness("bot", { spec: CLI_SPEC });
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["doctor"],
      allowMutating: false,
      deps: emptyDeps(),
      runner: async () => ({ exitCode: 77, tail: "" }),
      confirm: async () => true,
    });
    const out = formatBulkReport(report).join("\n");
    expect(out).toContain("✗ concierge — exit 77");
    expect(out).toContain("0 passed, 1 failed (unknown ×1), 0 skipped");
  });
});
