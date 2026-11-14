/** `crewhaus commands list|show`: a harness's receipts, newest first, read from its ledger. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandsCommand } from "./commands-cmd";
import { directControl } from "./daemon-cmd";

let base: string;
let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-commands-cmd-")));
  dir = join(base, "alpha");
  mkdirSync(dir);
  env = {
    CREWHAUS_HANGAR_ROOT: join(base, "hangar"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
  };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("crewhaus commands", () => {
  test("list shows the newest first; show reads one", async () => {
    const control = directControl({ env });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const answer = await control.commands.submit(
        { kind: "controls.pause", ledger: { harness: dir }, via: "cli" },
        async () => ({ settle: { state: "succeeded" }, value: i }),
      );
      if (!answer.ok) throw new Error("refused");
      ids.push(answer.receipt.id);
    }
    const listed = await runCommandsCommand(["list", "--harness", dir], {
      env,
      control: () => control,
    });
    expect(listed.exitCode).toBe(0);
    expect(listed.lines[0]?.startsWith(ids[1] as string)).toBe(true);
    expect(listed.lines[1]?.startsWith(ids[0] as string)).toBe(true);
    const shown = await runCommandsCommand(["show", ids[0] as string, "--harness", dir, "--json"], {
      env,
      control: () => control,
    });
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.lines.join("\n")).kind).toBe("controls.pause");
  });

  test("a missing harness, a bad id and an unknown command each say so", async () => {
    const control = directControl({ env });
    expect((await runCommandsCommand(["list"], { env, control: () => control })).exitCode).toBe(55);
    expect(
      (
        await runCommandsCommand(["list", "--harness", join(base, "nope")], {
          env,
          control: () => control,
        })
      ).exitCode,
    ).toBe(56);
    expect(
      (await runCommandsCommand(["show", "cmd_x"], { env, control: () => control })).exitCode,
    ).toBe(55);
    expect(
      (
        await runCommandsCommand(["show", "cmd_01m76e6f05hp514w9j4v3qymka", "--harness", dir], {
          env,
          control: () => control,
        })
      ).exitCode,
    ).toBe(56);
  });
});
