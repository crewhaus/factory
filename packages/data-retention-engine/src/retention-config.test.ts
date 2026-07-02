import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SESSION_MAX_AGE_DAYS,
  RetentionConfigError,
  loadRetentionConfig,
} from "./retention-config";

const MS_PER_DAY = 86_400_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-retention-config-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(cfg: unknown): void {
  mkdirSync(join(root, ".crewhaus"), { recursive: true });
  writeFileSync(
    join(root, ".crewhaus", "retention.json"),
    typeof cfg === "string" ? cfg : JSON.stringify(cfg),
  );
}

// The loader lives HERE (not in apps/cli) so the daemon janitors and the CLI
// parse the same file identically — ops-review F2. These tests pin the
// package-level contract; the CLI re-exports and re-tests it end-to-end.
describe("loadRetentionConfig", () => {
  test("missing file → 30-day default, no pins, no windows, fromFile=false", async () => {
    const cfg = await loadRetentionConfig(root);
    expect(cfg).toEqual({
      sessionMaxAgeDays: DEFAULT_SESSION_MAX_AGE_DAYS,
      pins: [],
      auditWindows: [],
      fromFile: false,
    });
  });

  test("parses maxAgeDays, pins, and windows; drops already-expired windows", async () => {
    const future = new Date(Date.now() + 5 * MS_PER_DAY).toISOString();
    const past = new Date(Date.now() - 5 * MS_PER_DAY).toISOString();
    writeConfig({
      version: 1,
      sessions: { maxAgeDays: 7 },
      pins: ["sess_aaaaaaaaaaaaaaaa"],
      auditWindows: [
        { frameworkId: "soc2", controlId: "CC6.1", expiresAt: future },
        { frameworkId: "soc2", controlId: "CC7.2", expiresAt: past },
      ],
    });
    const cfg = await loadRetentionConfig(root);
    expect(cfg.sessionMaxAgeDays).toBe(7);
    expect(cfg.pins).toEqual(["sess_aaaaaaaaaaaaaaaa"]);
    expect(cfg.auditWindows.map((w) => w.controlId)).toEqual(["CC6.1"]);
    expect(cfg.fromFile).toBe(true);
  });

  test("malformed JSON / bad maxAgeDays / bad pin / bad window all throw RetentionConfigError", async () => {
    writeConfig("{nope");
    await expect(loadRetentionConfig(root)).rejects.toThrow(RetentionConfigError);
    await expect(loadRetentionConfig(root)).rejects.toThrow(/malformed JSON/);
    writeConfig({ sessions: { maxAgeDays: 0 } });
    await expect(loadRetentionConfig(root)).rejects.toThrow(/maxAgeDays/);
    writeConfig({ pins: ["not-a-session-id"] });
    await expect(loadRetentionConfig(root)).rejects.toThrow(/not a session id/);
    writeConfig({ auditWindows: [{ frameworkId: "soc2" }] });
    await expect(loadRetentionConfig(root)).rejects.toThrow(/auditWindow/);
  });

  test("injected clock decides window expiry", async () => {
    const expiresAt = Date.parse("2026-08-01T00:00:00Z");
    writeConfig({
      auditWindows: [{ frameworkId: "soc2", controlId: "CC6.1", expiresAt }],
    });
    const before = await loadRetentionConfig(root, () => expiresAt - 1);
    expect(before.auditWindows).toHaveLength(1);
    const after = await loadRetentionConfig(root, () => expiresAt + 1);
    expect(after.auditWindows).toHaveLength(0);
  });
});
