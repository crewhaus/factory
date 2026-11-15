import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_TOKEN_FILES, removeRunTokens } from "./index";

const RUN_TOKENS = ["run/control-token", "run/gateway-jwt-secret", "run/mcp-token"] as const;
const SESSION_ID = "sess_00000000000000fe";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-run-tokens-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A running daemon's state: its three run tokens (fresh random values,
 *  0600), the run dir's .gitignore and one session. Returns the token values. */
function seedRunningState(stateDir: string): Record<string, string> {
  mkdirSync(join(stateDir, "run"), { recursive: true });
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  const values: Record<string, string> = {};
  for (const rel of RUN_TOKENS) {
    const value = randomBytes(24).toString("hex");
    writeFileSync(join(stateDir, rel), value, { mode: 0o600 });
    values[rel] = value;
  }
  writeFileSync(join(stateDir, "run", ".gitignore"), "*\n");
  writeFileSync(join(stateDir, "sessions", `${SESSION_ID}.jsonl`), '{"ts":1}\n');
  return values;
}

describe("an archived state directory holds no run token", () => {
  test("removeRunTokens removes the three and nothing else", () => {
    const stateDir = join(tmp, "crewhaus-state");
    seedRunningState(stateDir);
    mkdirSync(join(stateDir, "memories"), { recursive: true });
    writeFileSync(join(stateDir, "memories", "control-token"), "a note\n");
    expect(RUN_TOKEN_FILES).toEqual([...RUN_TOKENS]);
    expect(removeRunTokens(stateDir)).toEqual([...RUN_TOKENS]);
    for (const rel of RUN_TOKENS) expect(existsSync(join(stateDir, rel))).toBe(false);
    expect(existsSync(join(stateDir, "run", ".gitignore"))).toBe(true);
    expect(existsSync(join(stateDir, "memories", "control-token"))).toBe(true);
    expect(existsSync(join(stateDir, "sessions", `${SESSION_ID}.jsonl`))).toBe(true);
    // Nothing left to remove the second time.
    expect(removeRunTokens(stateDir)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "removeRunTokens never follows a linked run directory",
    () => {
      const outside = join(tmp, "outside");
      seedRunningState(outside);
      const stateDir = join(tmp, "crewhaus-state");
      mkdirSync(stateDir, { recursive: true });
      symlinkSync(join(outside, "run"), join(stateDir, "run"));
      expect(removeRunTokens(stateDir)).toEqual([]);
      for (const rel of RUN_TOKENS) expect(existsSync(join(outside, rel))).toBe(true);
    },
  );

  test("a state directory with no run directory has nothing to remove", () => {
    const stateDir = join(tmp, "crewhaus-state");
    mkdirSync(join(stateDir, "sessions"), { recursive: true });
    expect(removeRunTokens(stateDir)).toEqual([]);
    expect(removeRunTokens(join(tmp, "absent"))).toEqual([]);
  });
});
