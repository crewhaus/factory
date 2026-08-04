/**
 * The four-lane timeline and the bundle-freshness verdict.
 *
 * The asymmetry under test: CADENCE is declared in the spec and therefore
 * knowable offline; PHASE (last fired, next due) is knowable only inside the
 * process that armed the timer. A lane must render its cadence with no
 * daemon running, and must not invent a phase it cannot know.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleFreshness, hashSpecSource } from "./bundle-freshness";
import { makeFixtureHarness } from "./fixture";
import { buildSchedulersView, declaredCadences } from "./schedulers";

const SPEC = [
  "name: cadence",
  "target: channel",
  "heartbeat:",
  "  every: 60s",
  "  instructions: check in",
  "schedule:",
  "  kind: cron",
  '  cron: "0 */6 * * *"',
  "  timezone: America/New_York",
  "  jitter: 30s",
  "memory:",
  "  recall: true",
  "  dream:",
  "    every: 24h",
  "    mode: full",
  "",
].join("\n");

describe("declared cadences", () => {
  test("heartbeat, cron schedule (with tz + jitter), and memory.dream are all read off the spec text", () => {
    expect(declaredCadences(SPEC)).toEqual({
      heartbeat: "every 60s",
      schedule: 'cron "0 */6 * * *" America/New_York ±30s',
      dream: "every 24h (full)",
    });
  });

  test("an interval schedule reads as an interval, and an absent block as absent", () => {
    const spec = [
      "name: x",
      "target: channel",
      "schedule:",
      "  kind: interval",
      "  every: 6h",
      "",
    ].join("\n");
    expect(declaredCadences(spec)).toEqual({ schedule: "every 6h" });
  });

  test("a spec a version ahead of this manager still renders its lanes", () => {
    // Lenient block scan, not a schema parse: an unknown sibling key must
    // not make a fleet row go blank.
    const spec = [
      "name: x",
      "target: channel",
      "heartbeat:",
      "  every: 90s",
      "  someFutureKey: true",
      "",
    ].join("\n");
    expect(declaredCadences(spec).heartbeat).toBe("every 90s");
  });
});

describe("scheduler timeline", () => {
  const root = mkdtempSync(join(tmpdir(), "hangar-sched-"));
  const dir = makeFixtureHarness(join(root, "h"), { specName: "cadence", noSpec: true });
  writeFileSync(join(dir, "crewhaus.yaml"), SPEC);

  test("offline: cadence renders, phase does not, and the pokeable reason names the cause", () => {
    const view = buildSchedulersView({
      harnessDir: dir,
      specYaml: SPEC,
      target: "channel",
      controlReason: "no control port — the daemon is not running",
    });
    expect(view.lanes.map((l) => l.lane)).toEqual(["heartbeat", "schedule", "dream", "janitor"]);
    expect(view.controlReachable).toBe(false);

    const heartbeat = view.lanes[0];
    expect(heartbeat?.armed).toBe(true);
    expect(heartbeat?.cadence).toBe("every 60s");
    expect(heartbeat?.cadenceSource).toBe("spec");
    // The number no offline reader can compute.
    expect(heartbeat?.nextDueAt).toBe(null);
    expect(heartbeat?.pokeable).toBe(false);
    // …and the reason is the CLIENT's own, passed straight through, so the
    // UI never has to guess which of the degradations it is looking at.
    expect(heartbeat?.pokeReason).toBe("no control port — the daemon is not running");
  });

  test("a lane the spec never declared is absent, not broken — and says so", () => {
    const view = buildSchedulersView({
      harnessDir: dir,
      specYaml: "name: x\ntarget: cli\n",
      target: "cli",
    });
    const schedule = view.lanes.find((l) => l.lane === "schedule");
    expect(schedule?.armed).toBe(false);
    expect(schedule?.pokeReason).toContain("declares no schedule");
    // A cli shape runs no janitor either.
    expect(view.lanes.find((l) => l.lane === "janitor")?.armed).toBe(false);
  });

  test("dream and janitor are never pokeable, and each explains why", () => {
    const view = buildSchedulersView({ harnessDir: dir, specYaml: SPEC, target: "channel" });
    const dream = view.lanes.find((l) => l.lane === "dream");
    expect(dream?.pokeable).toBe(false);
    expect(dream?.pokeReason).toContain("dream-run job");
    const janitor = view.lanes.find((l) => l.lane === "janitor");
    expect(janitor?.pokeable).toBe(false);
    expect(janitor?.pokeReason).toContain("cannot be poked");
  });

  test("online: phase comes from control.v1, cadence still comes from the spec", () => {
    const view = buildSchedulersView({
      harnessDir: dir,
      specYaml: SPEC,
      target: "channel",
      control: {
        protocol: "crewhaus.control.v1",
        name: "cadence",
        target: "channel",
        pid: 1,
        startedAt: "2026-08-03T00:00:00.000Z",
        draining: false,
        counters: { turns: 1, heartbeatTicks: 4, scheduleWakes: 0, janitorRuns: 2 },
        timers: [
          {
            lane: "heartbeat",
            cadence: "every 60000ms",
            lastFiredAt: "2026-08-03T00:00:00.000Z",
            lastOutcome: "ok",
            nextDueAt: "2026-08-03T00:01:00.000Z",
          },
          { lane: "janitor", cadence: "every 3600000ms" },
        ],
        channels: ["slack"],
        pendingApprovals: 0,
      },
    });
    const heartbeat = view.lanes[0];
    expect(heartbeat?.cadence).toBe("every 60s"); // spec wins for cadence
    expect(heartbeat?.nextDueAt).toBe("2026-08-03T00:01:00.000Z");
    expect(heartbeat?.pokeable).toBe(true);
    // The spec declares `schedule:` but the BUNDLE armed no such lane —
    // a recompile-needed fact, not an error.
    const schedule = view.lanes.find((l) => l.lane === "schedule");
    expect(schedule?.armed).toBe(true);
    expect(schedule?.pokeable).toBe(false);
    expect(schedule?.pokeReason).toContain("armed no schedule lane");
    expect(view.counters?.janitorRuns).toBe(2);
  });

  test("a draining daemon refuses pokes for the right reason", () => {
    const view = buildSchedulersView({
      harnessDir: dir,
      specYaml: SPEC,
      target: "channel",
      control: {
        protocol: "crewhaus.control.v1",
        name: "cadence",
        target: "channel",
        pid: 1,
        startedAt: "2026-08-03T00:00:00.000Z",
        draining: true,
        counters: { turns: 0, heartbeatTicks: 0, scheduleWakes: 0, janitorRuns: 0 },
        timers: [{ lane: "heartbeat", cadence: "every 60000ms" }],
        channels: [],
        pendingApprovals: 0,
      },
    });
    expect(view.draining).toBe(true);
    expect(view.lanes[0]?.pokeReason).toContain("draining");
  });

  rmSync(root, { recursive: true, force: true });
});

describe("bundle freshness (F-5)", () => {
  const root = mkdtempSync(join(tmpdir(), "hangar-fresh-"));
  const yaml = "name: fresh\ntarget: channel\n";

  const make = (name: string, stamp?: string): string =>
    makeFixtureHarness(join(root, name), {
      specName: "fresh",
      noSpec: true,
      bundle: { entry: "daemon.ts", ...(stamp !== undefined ? { specHash: stamp } : {}) },
    });

  const verdict = (dir: string): ReturnType<typeof bundleFreshness> => {
    writeFileSync(join(dir, "crewhaus.yaml"), yaml);
    return bundleFreshness({
      specYaml: yaml,
      specPath: join(dir, "crewhaus.yaml"),
      outDir: join(dir, "dist"),
      entryPath: join(dir, "dist", "daemon.ts"),
    });
  };

  test("a matching stamp is EXACT fresh", () => {
    const v = verdict(make("stamped-fresh", hashSpecSource(yaml)));
    expect(v.state).toBe("fresh");
    expect(v.exact).toBe(true);
  });

  test("a mismatched stamp is EXACT stale", () => {
    const v = verdict(make("stamped-stale", `sha256:${"1".repeat(64)}`));
    expect(v.state).toBe("stale");
    expect(v.exact).toBe(true);
    expect(v.label).toContain("recompile");
  });

  test("a pre-F-5 bundle falls back to mtimes and LABELS the answer approximate", () => {
    const dir = make("unstamped");
    // Make the spec newer than the bundle.
    writeFileSync(join(dir, "crewhaus.yaml"), yaml);
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "dist", "daemon.ts"), past, past);
    const v = bundleFreshness({
      specYaml: yaml,
      specPath: join(dir, "crewhaus.yaml"),
      outDir: join(dir, "dist"),
      entryPath: join(dir, "dist", "daemon.ts"),
    });
    expect(v.state).toBe("approximate-stale");
    expect(v.exact).toBe(false);
    expect(v.label).toContain("approximate");
  });

  test("no bundle at all is `unknown`, not `stale`", () => {
    const dir = makeFixtureHarness(join(root, "nobundle"), { specName: "fresh" });
    const v = bundleFreshness({
      specYaml: yaml,
      specPath: join(dir, "crewhaus.yaml"),
      outDir: join(dir, "dist"),
      entryPath: join(dir, "dist", "daemon.ts"),
    });
    expect(v.state).toBe("unknown");
    expect(v.label).toContain("no compiled bundle");
  });

  test("a trailing newline and CRLF do not change the spec hash", () => {
    // A spec re-saved by an editor, or checked out on Windows, must not read
    // as a spec change — that would nag every operator into a needless
    // recompile and teach them to ignore the badge.
    expect(hashSpecSource("a: 1\n")).toBe(hashSpecSource("a: 1"));
    expect(hashSpecSource("a: 1\r\nb: 2\r\n")).toBe(hashSpecSource("a: 1\nb: 2\n"));
    // …but a real content change does.
    expect(hashSpecSource("a: 1\n")).not.toBe(hashSpecSource("a: 2\n"));
  });

  rmSync(root, { recursive: true, force: true });
});
