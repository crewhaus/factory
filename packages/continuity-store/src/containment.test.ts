/**
 * C070: every file the store reads or writes stays inside the store.
 *
 * The store used to write `<file>.tmp` with link following and rename it into
 * place, and read its files with link following. A symlink planted at a temp
 * name (dangling or not) made FocusWrite, GoalWrite, PlanUpdate and the
 * handoff create or overwrite a file anywhere the process could write, with
 * the model's own text; a link at the file itself was read or replaced
 * through. Each test plants one such link and asserts both halves: the
 * outside file is untouched, and the store says why it refused (or wrote a
 * regular file in place).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRetentionPins } from "./evidence";
import { type ContinuityStore, FOCUS_MARKER, createContinuityStore } from "./index";

let tmp: string;
let outside: string;
let store: ContinuityStore;

const SESS = "sess_0123456789abcdef";

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "continuity-contain-")));
  outside = join(tmp, "outside");
  mkdirSync(outside);
  store = createContinuityStore({
    specName: "poc",
    rootDir: join(tmp, "ws", ".crewhaus", "state"),
    now: () => new Date("2026-09-29T12:00:00.000Z"),
  });
  mkdirSync(store.dir(), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const isRegularFile = (p: string): boolean => lstatSync(p).isFile();

describe("writes never follow a link planted at the old fixed temp name", () => {
  test("focus.md.tmp dangling out: the focus is written in place, nothing is created outside", async () => {
    const target = join(outside, "planted.sh");
    symlinkSync(target, join(store.dir(), "focus.md.tmp"));
    await store.writeFocus("model-chosen focus text");
    expect(existsSync(target)).toBe(false);
    const focusPath = join(store.dir(), "focus.md");
    expect(isRegularFile(focusPath)).toBe(true);
    expect(readFileSync(focusPath, "utf8")).toContain("model-chosen focus text");
  });

  test("goals.yaml.tmp leading to an existing outside file: that file is not overwritten", async () => {
    const victim = join(outside, "victim.rc");
    writeFileSync(victim, "ORIGINAL\n");
    symlinkSync(victim, join(store.dir(), "goals.yaml.tmp"));
    const goal = await store.writeGoal({ title: "t" });
    expect(goal.id).toBe("goal-0001");
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(isRegularFile(join(store.dir(), "goals.yaml"))).toBe(true);
  });

  test("plans/<plan>.md.tmp dangling out: the plan is written, nothing outside", async () => {
    const target = join(outside, "plan-out.md");
    mkdirSync(join(store.dir(), "plans"));
    symlinkSync(target, join(store.dir(), "plans", "plan-0001-ship-it.md.tmp"));
    const plan = await store.createPlan({ title: "Ship it", steps: ["one"] });
    expect(plan.id).toBe("plan-0001");
    expect(existsSync(target)).toBe(false);
    expect(isRegularFile(join(store.dir(), "plans", "plan-0001-ship-it.md"))).toBe(true);
  });

  test("handoff.md.tmp dangling out: the handoff is written, nothing outside", async () => {
    const target = join(outside, "handoff-out.md");
    symlinkSync(target, join(store.dir(), "handoff.md.tmp"));
    const written = await store.writeHandoff();
    expect(existsSync(target)).toBe(false);
    expect(isRegularFile(written)).toBe(true);
  });
});

describe("a link AT a store file leading OUT is refused, naming the store path and the reason", () => {
  test("focus.md linked to an outside file carrying the marker: neither read nor replaced", async () => {
    const secret = join(outside, "secret.md");
    const text = `${FOCUS_MARKER}\n# Focus\n\nOUTSIDE-SECRET\n`;
    writeFileSync(secret, text);
    symlinkSync(secret, join(store.dir(), "focus.md"));
    await expect(store.readFocus()).rejects.toThrow(
      /focus\.md.*resolves outside the continuity store/,
    );
    await expect(store.writeFocus("overwrite")).rejects.toThrow(
      /focus\.md.*resolves outside the continuity store/,
    );
    expect(readFileSync(secret, "utf8")).toBe(text);
  });

  test("a leaf link that STAYS inside the store is followed for read and write", async () => {
    // An operator-created in-store link is the store's own business, not an
    // escape: 0.7.0 read and wrote through it, and it must keep working.
    const kept = join(store.dir(), "focus-kept.md");
    writeFileSync(kept, `${FOCUS_MARKER}\n# Focus\n\nKEPT\n`);
    symlinkSync(kept, join(store.dir(), "focus.md"));
    const focus = await store.readFocus();
    expect(focus?.body).toContain("KEPT");
    await store.writeFocus("rewritten through the link");
    // The write lands in the link's target, and the link is still a link.
    expect(lstatSync(join(store.dir(), "focus.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(kept, "utf8")).toContain("rewritten through the link");
  });

  test("plans/ linked to an outside directory: a new plan is refused as outside the store", async () => {
    const outPlans = join(outside, "plans");
    mkdirSync(outPlans);
    symlinkSync(outPlans, join(store.dir(), "plans"));
    await expect(store.createPlan({ title: "Leak", steps: ["x"] })).rejects.toThrow(
      /plans\/plan-0001-leak\.md: it resolves outside the continuity store/,
    );
    expect(existsSync(join(outPlans, "plan-0001-leak.md"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a FIFO at goals.yaml is refused, not waited on",
    async () => {
      const fifo = join(store.dir(), "goals.yaml");
      const made = Bun.spawnSync(["mkfifo", fifo]);
      expect(made.exitCode).toBe(0);
      // If a regression opens the FIFO, the read blocks until a writer comes
      // and goes. This one comes late, so such a regression FAILS (an empty
      // goals list instead of a refusal) rather than hanging the suite. The
      // fixed store never opens the FIFO, so it has nothing to race.
      const unblock = setTimeout(() => {
        try {
          closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
        } catch {
          // ENXIO: nobody is reading, which is the fixed behaviour.
        }
      }, 2_000);
      try {
        await expect(store.listGoals()).rejects.toThrow(
          /goals\.yaml.*is a fifo, not a regular file/,
        );
      } finally {
        clearTimeout(unblock);
      }
    },
    10_000,
  );
});

describe("retention.json pins are contained within the workspace", () => {
  // The harness root (containment root) is the parent of .crewhaus.
  const wsRoot = (): string => join(tmp, "ws");

  test("retention.json.tmp leading to an outside file: it is not overwritten", async () => {
    const dir = join(tmp, "ws", ".crewhaus");
    const victim = join(outside, "victim.json");
    writeFileSync(victim, "ORIGINAL\n");
    symlinkSync(victim, join(dir, "retention.json.tmp"));
    const { added } = await appendRetentionPins([SESS], join(dir, "retention.json"), wsRoot());
    expect(added).toEqual([SESS]);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(isRegularFile(join(dir, "retention.json"))).toBe(true);
  });

  test("retention.json linked to a sibling config/ inside the workspace: the pin lands in the target", async () => {
    // An operator who keeps the retention policy under config/ and links
    // .crewhaus/retention.json to it must keep working (0.7.0 behaviour): the
    // link stays inside the workspace, so it is followed, not refused.
    const dir = join(tmp, "ws", ".crewhaus");
    const config = join(tmp, "ws", "config");
    mkdirSync(config, { recursive: true });
    const target = join(config, "retention.json");
    writeFileSync(target, '{"version":1,"pins":["sess_00000000000000aa"]}\n');
    symlinkSync(target, join(dir, "retention.json"));
    const { added } = await appendRetentionPins([SESS], join(dir, "retention.json"), wsRoot());
    expect(added).toEqual([SESS]);
    // The pin was appended to the linked file, and the link is still a link.
    expect(lstatSync(join(dir, "retention.json")).isSymbolicLink()).toBe(true);
    const written = JSON.parse(readFileSync(target, "utf8")) as { pins: string[] };
    expect(written.pins).toEqual(["sess_00000000000000aa", SESS]);
  });

  test("retention.json linked OUT of the workspace: refused, the outside file untouched", async () => {
    const dir = join(tmp, "ws", ".crewhaus");
    const victim = join(outside, "retention.json");
    writeFileSync(victim, '{"version":1}\n');
    symlinkSync(victim, join(dir, "retention.json"));
    await expect(
      appendRetentionPins([SESS], join(dir, "retention.json"), wsRoot()),
    ).rejects.toThrow(/retention\.json links outside the workspace/);
    expect(readFileSync(victim, "utf8")).toBe('{"version":1}\n');
  });

  test("an escaping retention link fails the proven transition BEFORE the status is saved", async () => {
    // Pin-before-write: the proof session is pinned before the proven status
    // lands, so a retention file that cannot be written fails the whole
    // transition instead of leaving a proven step the pin never covered — TTL
    // eviction could then orphan its evidence. (The store reads sessions and
    // retention.json under .crewhaus.)
    await store.createPlan({ title: "Ship", steps: ["run tests"] });
    const sessDir = join(tmp, "ws", ".crewhaus", "sessions");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, `${SESS}.jsonl`),
      `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: "tu_x", name: "Bash", input: {} } })}\n${JSON.stringify(
        {
          ts: 2,
          version: 1,
          kind: "tool_result",
          payload: { toolUseId: "tu_x", content: "42 pass", isError: false },
        },
      )}\n`,
    );
    symlinkSync(join(outside, "retention.json"), join(tmp, "ws", ".crewhaus", "retention.json"));
    await expect(
      store.proveStep("plan-0001", 1, [{ toolUseId: "tu_x", sessionId: SESS }]),
    ).rejects.toThrow(/retention\.json links outside the workspace/);
    // The step is still unproven on disk: the status write never ran.
    const plan = await store.getPlan("plan-0001");
    expect(plan?.steps[0]?.status).not.toBe("proven");
  });
});
