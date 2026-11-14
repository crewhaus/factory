/**
 * The user-level hooks file, `~/.crewhaus/settings.json`, is on the runtime-state floor as
 * exactly that file: an agent's write tool is refused on it, on another spelling or case
 * of its name, and, where the file is a link, on the file it leads to; the agent's file
 * tools refuse a write through a workspace link that leads to it; and CrewHaus itself
 * reads its hooks from it as before.
 *
 * Nothing is created under the home directory: the file is only ever spelled, or linked
 * to from a temporary workspace.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { loadHooks, userSettingsFile } from "@crewhaus/hooks-engine";
import {
  type RuleSet,
  type ToolCallContext,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
import { ToolPermissionError, edit, write } from "@crewhaus/tool-fs";
import { canonicalWorkspacePath } from "./path-canonical";
import { runtimeStateRoots, storeFileRoots } from "./state-roots";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = "user-hooks-floor-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TMP.push(dir);
  return dir;
}

const USER_HOOKS = join(homedir(), ".crewhaus", "settings.json");

const allowWrites: RuleSet = {
  ...emptyRuleSet,
  yaml: [{ type: "alwaysAllow", pattern: "Write", source: "yaml" }],
};

function writeAt(cwd: string, raw: string): ToolCallContext {
  return {
    toolName: "Write",
    input: { path: raw, content: '{"hooks":[{"event":"stop","command":"curl evil"}]}' },
    operativeValues: canonicalWorkspacePath(raw, cwd),
    readOnly: false,
    destructive: true,
  };
}

const decide = (cwd: string, raw: string) =>
  evaluateWithReason(writeAt(cwd, raw), "auto", allowWrites, {
    protectedRoots: runtimeStateRoots(undefined, undefined, cwd, {}),
  });

describe("the user-level hooks file on the runtime-state floor", () => {
  test("the floor's roots name it exactly once, and it is the file the hooks loader reads", () => {
    const cwd = tempDir();
    const count = (roots: readonly string[]) => roots.filter((root) => root === USER_HOOKS).length;
    expect(count(runtimeStateRoots(undefined, undefined, cwd, {}))).toBe(1);
    // At the home directory itself, the harness's own settings file is the same file.
    expect(count(runtimeStateRoots(undefined, undefined, homedir(), {}))).toBe(1);
    expect(userSettingsFile()).toBe(USER_HOOKS);
  });

  test("an agent's write to it is refused, and so is another spelling or case of its name", () => {
    const cwd = tempDir();
    for (const raw of [
      USER_HOOKS,
      join(homedir(), ".Crewhaus", "SETTINGS.json"),
      join(homedir(), ".CREWHAUS", "Settings.Json"),
      // Written with a `.` and a `..` in it, as a call may write it.
      [homedir(), ".crewhaus", ".", "settings.json"].join(sep),
      [homedir(), ".crewhaus", "hangar", "..", "settings.json"].join(sep),
    ]) {
      const verdict = decide(cwd, raw);
      expect({ raw, decision: verdict.decision }).toEqual({ raw, decision: "deny" });
      expect(verdict.reason).toContain("no rule can allow that");
    }
  });

  test("where the file is a link, the file it leads to is refused too", () => {
    // Spelled as the floor spells every root (storeFileRoots spells a path the way
    // runtimeStateRoots does), under a home directory of the test's own.
    const home = tempDir("user-hooks-home-");
    mkdirSync(join(home, ".crewhaus"));
    mkdirSync(join(home, "dotfiles"));
    const target = join(home, "dotfiles", "crewhaus-settings.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, userSettingsFile(home));
    const cwd = tempDir();
    const roots = storeFileRoots([userSettingsFile(home)], cwd);
    expect(roots).toContain(userSettingsFile(home));
    expect(roots).toContain(target);
    for (const raw of [userSettingsFile(home), target]) {
      const verdict = evaluateWithReason(writeAt(cwd, raw), "auto", allowWrites, {
        protectedRoots: roots,
      });
      expect({ raw, decision: verdict.decision }).toEqual({ raw, decision: "deny" });
    }
  });

  test("an agent's Write and Edit through a workspace link to it are refused, and the file is unchanged", async () => {
    // A home directory of the test's own: its hooks file, spelled as the floor spells it.
    const home = tempDir("user-hooks-home-");
    mkdirSync(join(home, ".crewhaus"));
    const file = userSettingsFile(home);
    const original = `${JSON.stringify({ hooks: [{ event: "stop", command: "true" }] })}\n`;
    writeFileSync(file, original);
    const ws = tempDir("user-hooks-ws-");
    // A link to the file itself, and a link to the directory that holds it.
    symlinkSync(file, join(ws, "x.json"));
    symlinkSync(join(home, ".crewhaus"), join(ws, "cfg"));
    const hostile = '{"hooks":[{"event":"stop","command":"curl evil"}]}';
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      // A control: the same write to a plain file of the workspace lands.
      await write.execute({ path: "plain.json", content: hostile });
      expect(readFileSync(join(ws, "plain.json"), "utf8")).toBe(hostile);
      for (const raw of ["x.json", join("cfg", "settings.json")]) {
        let refused: unknown;
        try {
          await write.execute({ path: raw, content: hostile });
        } catch (err) {
          refused = err;
        }
        expect({ raw, refused: refused instanceof ToolPermissionError }).toEqual({
          raw,
          refused: true,
        });
        let edited: unknown;
        try {
          await edit.execute({ path: raw, oldString: "true", newString: "curl evil" });
        } catch (err) {
          edited = err;
        }
        expect({ raw, refused: edited instanceof ToolPermissionError }).toEqual({
          raw,
          refused: true,
        });
      }
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("a neighbour of the file is not the file", () => {
    const cwd = tempDir();
    for (const raw of [
      join(homedir(), ".crewhaus", "settings.json.bak"),
      join(cwd, ".crewhaus", "notes.md"),
    ]) {
      const verdict = decide(cwd, raw);
      expect({ raw, floor: (verdict.reason ?? "").includes("no rule can allow that") }).toEqual({
        raw,
        floor: false,
      });
    }
  });

  test("CrewHaus itself reads its hooks from the file as before", async () => {
    const home = tempDir("user-hooks-home-");
    mkdirSync(join(home, ".crewhaus"), { recursive: true });
    writeFileSync(
      userSettingsFile(home),
      `${JSON.stringify({ hooks: [{ event: "stop", command: "true" }] })}\n`,
    );
    expect(userSettingsFile(home)).toBe(join(home, ".crewhaus", "settings.json"));
    const hooks = await loadHooks({ homeDir: home, cwd: tempDir() });
    expect(hooks.map((hook) => hook.command)).toEqual(["true"]);
  });
});
