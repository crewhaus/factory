/**
 * HM-202 — `fleet` / `harness` signposting.
 *
 * `crewhaus fleet` is kept indefinitely, so the help text has one job: stop
 * an operator guessing which verb is the survivor, and make sure whichever
 * one they found first leads to the other. The axis is filesystem-centric
 * (`fleet`: walks `--root`, no registry, no console) versus registry-centric
 * (`harness`: machine-wide, groups/tags/pins, preflight, the Hangar console).
 *
 * Asserted on the TEXT rather than on a screenshot of it: these three
 * surfaces (`fleet --help`, `harness --help`, top-level `crewhaus --help`)
 * are the only in-repo documentation either verb has.
 */
import { describe, expect, test } from "bun:test";
import { FLEET_USAGE } from "./fleet";
import { runHarnessCommand } from "./harness-cmd";
import { usageText } from "./usage-text";

describe("fleet --help", () => {
  test("points at `crewhaus harness` so the registry is discoverable from here", () => {
    expect(FLEET_USAGE).toContain("crewhaus harness");
    expect(FLEET_USAGE).toContain("FILESYSTEM-centric");
    expect(FLEET_USAGE).toContain("REGISTRY-centric");
  });

  test("says both are supported — no operator should read it as a deprecation", () => {
    expect(FLEET_USAGE).toContain("Both are supported");
    expect(FLEET_USAGE).not.toContain("deprecated");
  });

  test("still documents every fleet verb it documented before the signpost", () => {
    for (const fragment of [
      "crewhaus fleet list",
      "crewhaus fleet status",
      "crewhaus fleet run <sub>",
      "--allow-mutating",
      "--group <name>",
      "eval, doctor, security digest, audit verify",
    ]) {
      expect(FLEET_USAGE).toContain(fragment);
    }
    // Written for `process.stdout.write`: one trailing newline, no more.
    expect(FLEET_USAGE.endsWith("\n")).toBe(true);
    expect(FLEET_USAGE.endsWith("\n\n")).toBe(false);
  });
});

describe("harness --help", () => {
  test("points back at `crewhaus fleet` and names the axis", async () => {
    // No registry is opened for the usage path, so no env injection is
    // needed here — and none must be required, or `--help` would touch the
    // real ~/.crewhaus.
    const out = await runHarnessCommand(["--help"]);
    const text = out.lines.join("\n");
    expect(out.exitCode).toBe(0);
    expect(text).toContain("crewhaus fleet");
    expect(text).toContain("REGISTRY-centric");
    expect(text).toContain("FILESYSTEM-centric");
    expect(text).toContain("Both are supported");
  });

  test("the bare verb and -h reach the same text", async () => {
    const bare = await runHarnessCommand([]);
    const short = await runHarnessCommand(["-h"]);
    expect(bare.lines).toEqual(short.lines);
  });
});

describe("crewhaus --help", () => {
  test("cross-references both verbs in the top-level subcommand list", () => {
    const text = usageText();
    expect(text).toContain("FILESYSTEM-centric (walks --root); `harness` is the");
    expect(text).toContain("REGISTRY-centric (machine-wide, any location); `fleet`");
  });

  test("the signpost lines sit in the description column and fit the width", () => {
    // The list is column-formatted at 39 characters; a signpost that wrapped
    // in a narrow terminal would read as a broken entry rather than a note.
    // (Only the added lines are measured — a handful of pre-existing entries
    // predate the budget.)
    const signposts = usageText()
      .split("\n")
      .filter((l) => /^ {39}\S/.test(l) && (l.includes("centric") || l.includes("twin")));
    expect(signposts).toHaveLength(4);
    for (const line of signposts) {
      expect(line.slice(0, 39).trim()).toBe("");
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
