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

describe("a link AT a store file is refused, naming the store path and the reason", () => {
  test("focus.md linked to an outside file carrying the marker: neither read nor replaced", async () => {
    const secret = join(outside, "secret.md");
    const text = `${FOCUS_MARKER}\n# Focus\n\nOUTSIDE-SECRET\n`;
    writeFileSync(secret, text);
    symlinkSync(secret, join(store.dir(), "focus.md"));
    await expect(store.readFocus()).rejects.toThrow(/focus\.md.*symbolic link/);
    await expect(store.writeFocus("overwrite")).rejects.toThrow(/focus\.md.*symbolic link/);
    expect(readFileSync(secret, "utf8")).toBe(text);
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

describe("retention.json pins stay inside .crewhaus", () => {
  test("retention.json.tmp leading to an outside file: it is not overwritten", async () => {
    const dir = join(tmp, "ws", ".crewhaus");
    const victim = join(outside, "victim.json");
    writeFileSync(victim, "ORIGINAL\n");
    symlinkSync(victim, join(dir, "retention.json.tmp"));
    const { added } = await appendRetentionPins([SESS], join(dir, "retention.json"));
    expect(added).toEqual([SESS]);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(isRegularFile(join(dir, "retention.json"))).toBe(true);
  });

  test("retention.json itself linked out: refused, the outside file untouched", async () => {
    const dir = join(tmp, "ws", ".crewhaus");
    const victim = join(outside, "retention.json");
    writeFileSync(victim, '{"version":1}\n');
    symlinkSync(victim, join(dir, "retention.json"));
    await expect(appendRetentionPins([SESS], join(dir, "retention.json"))).rejects.toThrow(
      /retention\.json.*symbolic link/,
    );
    expect(readFileSync(victim, "utf8")).toBe('{"version":1}\n');
  });
});
