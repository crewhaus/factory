/**
 * The Inspect screen's one write, and the rule that governs it.
 *
 * `.crewhaus/settings.json` is served MASKED — `[redacted]` for values under
 * credential-named keys (`env` is one), `***` for a token-shaped span inside
 * a hook command. The editor used to seed its textarea from that masked
 * document and PUT it straight back, which replaced the agent's real env and
 * hook commands with the placeholders, atomically, behind a success toast
 * and a typed confirmation that made it look deliberate.
 *
 * A masked read is a view, never a source for a write. The decision is pure,
 * so it is proven here.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { settingsWriteGuard } from "../assets/js/views/inspect.js";

describe("settingsWriteGuard", () => {
  test("a clean document is writable and carries no reason", () => {
    const guard = settingsWriteGuard(
      { permissions: { allow: ["Bash(ls:*)"] }, hooks: [{ event: "PreToolUse", command: "true" }] },
      ".crewhaus/settings.json",
    );
    expect(guard).toEqual({ blocked: false, marks: [], reason: null });
  });

  test("a redacted env map blocks the write — that is the data-loss case", () => {
    // What the server actually serves: `env` is a credential CONTAINER key,
    // so every value under it is replaced wholesale, secret or not.
    const guard = settingsWriteGuard({
      env: { MY_SERVICE_URL: "[redacted]", OTEL_ENDPOINT: "[redacted]" },
    });
    expect(guard.blocked).toBe(true);
    expect(guard.marks).toContain("[redacted]");
  });

  test("a masked span inside a hook command blocks it too", () => {
    const guard = settingsWriteGuard({
      hooks: [{ event: "PreToolUse", command: "curl -H 'Authorization: Bearer ***' https://x" }],
    });
    expect(guard.blocked).toBe(true);
    expect(guard.marks).toContain("***");
  });

  test("the refusal names both markers, the file to edit, and a verb", () => {
    const guard = settingsWriteGuard(
      { env: { A: "[redacted]" }, hooks: [{ command: "x ***" }] },
      ".crewhaus/settings.json",
    );
    expect(guard.marks).toEqual(["[redacted]", "***"]);
    const reason = String(guard.reason);
    expect(reason).toContain(".crewhaus/settings.json");
    expect(reason).toContain("crewhaus permissions suggest");
    // It must say WHY, not just "no".
    expect(reason).toContain("mask");
  });

  test("a marker at any depth, and in a key, is still a marker", () => {
    expect(settingsWriteGuard({ a: { b: [{ c: "[redacted]" }] } }).blocked).toBe(true);
    expect(settingsWriteGuard({ "***": 1 }).blocked).toBe(true);
  });

  test("a missing document is writable (an absent file is not a masked one)", () => {
    expect(settingsWriteGuard(null).blocked).toBe(false);
    expect(settingsWriteGuard(undefined).blocked).toBe(false);
    expect(settingsWriteGuard({}).blocked).toBe(false);
  });

  test("a document that cannot be serialized is refused rather than guessed at", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const guard = settingsWriteGuard(cyclic);
    expect(guard.blocked).toBe(true);
    expect(String(guard.reason).length).toBeGreaterThan(0);
  });

  test("it falls back to naming the store when no path is handed in", () => {
    expect(String(settingsWriteGuard({ env: { A: "[redacted]" } }).reason)).toContain(
      ".crewhaus/settings.json",
    );
  });
});

describe("the view module's own hygiene", () => {
  test("the editor consults the guard on the way IN and on the way OUT", async () => {
    const source = await Bun.file(new URL("../assets/js/views/inspect.js", import.meta.url)).text();
    // Once when seeding the textarea (read-only + reason), once on submit —
    // text pasted in from the raw view must not slip past it.
    const calls = source.split("settingsWriteGuard(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(3); // definition + both call sites
    expect(source.includes("editor.readOnly = true")).toBe(true);
    expect(source.includes("previewBtn.disabled = guard.blocked")).toBe(true);
    expect(source.includes("applyBtn.disabled = guard.blocked")).toBe(true);
  });

  test("the panel says why it is read-only rather than just greying out", async () => {
    const source = await Bun.file(new URL("../assets/js/views/inspect.js", import.meta.url)).text();
    expect(source.includes('dot("warn", "read-only here")')).toBe(true);
    expect(source.includes("guard.reason")).toBe(true);
  });
});
