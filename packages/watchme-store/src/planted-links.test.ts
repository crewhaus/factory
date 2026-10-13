/**
 * 0.7.1 — the watch-me store never writes through a link planted in it.
 *
 * `crewhaus watchme` opens the store at `./.crewhaus/watchme`, inside the
 * workspace, so a model with GitApplyPatch (whose patch can create a symlink)
 * can plant one there. 0.7.0 wrote the fixed `state.json.tmp` and
 * `observations.jsonl.tmp` through such a link and renamed it into place:
 * `crewhaus watchme stop` replaced the file the link named with the store's
 * state JSON. The observation and judgment appends followed a link at either
 * log. Each case asserts the property (the outside file is untouched, nothing
 * is created outside) and the reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarnessRegistry } from "./registry";
import { WatchmeStoreError, openWatchmeStore } from "./store";
import type { WatchmeJudgment, WatchmeObservation } from "./types";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const VICTIM_TEXT = "ORIGINAL-AUTHORIZED-KEYS\n";

/** A workspace `.crewhaus` with `watchme/` in it, and a victim outside. */
function layout(): { crewhaus: string; watchme: string; outside: string; victim: string } {
  const base = mkdtempSync(join(tmpdir(), "watchme-links-"));
  ROOTS.push(base);
  const crewhaus = join(base, "ws", ".crewhaus");
  const watchme = join(crewhaus, "watchme");
  const outside = join(base, "outside");
  mkdirSync(watchme, { recursive: true });
  mkdirSync(outside);
  const victim = join(outside, "victim");
  writeFileSync(victim, VICTIM_TEXT);
  return { crewhaus, watchme, outside, victim };
}

const OBS: WatchmeObservation = {
  v: 1,
  sessionId: "sess_0123456789abcdef",
  specName: "helpdesk",
  target: "cli",
  ts: 1_700_000_000_000,
  turnCount: 3,
  joinConfidence: "exact",
  models: [],
  toolStats: [],
  intentKeys: [],
} as unknown as WatchmeObservation;

const JUDGMENT: WatchmeJudgment = {
  v: 1,
  sessionId: "sess_0123456789abcdef",
  turnNumber: 1,
  model: "m",
  judgeModel: "m",
  score: 1,
  rationale: "$(touch /tmp/pwned)",
  ts: 1_700_000_000_000,
} as unknown as WatchmeJudgment;

describe("watch-me store writes (0.7.1)", () => {
  test("setState (`watchme stop`) never writes through a link planted at state.json.tmp", () => {
    const { crewhaus, watchme, victim } = layout();
    symlinkSync(victim, join(watchme, "state.json.tmp"));
    const store = openWatchmeStore(crewhaus, { specName: "s" });
    store.setState({ watching: false });
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(watchme, "state.json")).isFile()).toBe(true);
    expect(store.state().watching).toBe(false);
  });

  test("compact never writes through a link planted at observations.jsonl.tmp", () => {
    const { crewhaus, watchme, victim } = layout();
    const store = openWatchmeStore(crewhaus, { specName: "s" });
    store.appendObservation(OBS);
    symlinkSync(victim, join(watchme, "observations.jsonl.tmp"));
    store.compact();
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(watchme, "observations.jsonl")).isFile()).toBe(true);
  });

  test("a link AT state.json is refused on write and on read, naming the reason", () => {
    const { crewhaus, watchme, victim } = layout();
    symlinkSync(victim, join(watchme, "state.json"));
    const store = openWatchmeStore(crewhaus, { specName: "s" });
    expect(() => store.setState({ watching: false })).toThrow(WatchmeStoreError);
    expect(() => store.state()).toThrow(/state\.json: .*\(code is-symlink\)/);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });

  test("appends refuse a link at observations.jsonl or judgments.jsonl", () => {
    const { crewhaus, watchme, victim } = layout();
    symlinkSync(victim, join(watchme, "observations.jsonl"));
    symlinkSync(victim, join(watchme, "judgments.jsonl"));
    const store = openWatchmeStore(crewhaus, { specName: "s" });
    expect(() => store.appendObservation(OBS)).toThrow(
      /observations\.jsonl: .*\(code is-symlink\)/,
    );
    expect(() => store.appendJudgment(JUDGMENT)).toThrow(/judgments\.jsonl: .*\(code is-symlink\)/);
    expect(() => store.readObservations()).toThrow(/\(code is-symlink\)/);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });

  test("a directory link planted at .crewhaus/watchme is refused: nothing lands outside", () => {
    const { crewhaus, outside } = layout();
    rmSync(join(crewhaus, "watchme"), { recursive: true });
    symlinkSync(outside, join(crewhaus, "watchme"));
    const store = openWatchmeStore(crewhaus, { specName: "s" });
    expect(() => store.setState({ watching: true })).toThrow(/\(code escapes-root\)/);
    expect(() => store.appendObservation(OBS)).toThrow(/\(code escapes-root\)/);
    expect(store.acquireLock).toThrow(/\(code escapes-root\)/);
    expect(readdirSync(outside)).toEqual(["victim"]);
  });
});

describe("the harness registry (0.7.1)", () => {
  test("register never writes through a link planted at harnesses.json.tmp", () => {
    const { outside, victim } = layout();
    // `--root` or CREWHAUS_WATCHME_ROOT can put the registry in a workspace.
    const root = join(outside, "..", "ws", "registry");
    mkdirSync(root, { recursive: true });
    symlinkSync(victim, join(root, "harnesses.json.tmp"));
    const registry = openHarnessRegistry(root, { onWarn: () => {} });
    registry.register({ dir: outside, specName: "s", target: "cli" } as never);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(root, "harnesses.json")).isFile()).toBe(true);
    expect(registry.list().map((e) => e.specName)).toEqual(["s"]);
  });

  test("a link AT harnesses.json is refused on write and on read", () => {
    const { outside, victim } = layout();
    const root = join(outside, "..", "ws", "registry");
    mkdirSync(root, { recursive: true });
    symlinkSync(victim, join(root, "harnesses.json"));
    const registry = openHarnessRegistry(root, { onWarn: () => {} });
    expect(() => registry.list()).toThrow(/\(code is-symlink\)/);
    expect(() =>
      registry.register({ dir: outside, specName: "s", target: "cli" } as never),
    ).toThrow(/\(code is-symlink\)/);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });
});
