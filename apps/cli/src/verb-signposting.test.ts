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
 *
 * `fleet`'s help is asserted on the CLI's REAL STDOUT, not on the exported
 * constant. The constant is reachable from a test whatever the entry file
 * does with it; `crewhaus fleet --help` used to die with "fleet action must
 * be one of: list, status, run", and a test against the string could not
 * tell. `harness` and the top-level usage are importable functions, so those
 * are driven directly.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FLEET_USAGE } from "./fleet";
import { runHarnessCommand } from "./harness-cmd";
import { usageText } from "./usage-text";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

/** Run the real CLI and return its stdout. Spawned with an explicit generous
 *  timeout: a hung help path must fail the suite, not wedge CI. */
async function cliStdout(...argv: readonly string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`crewhaus ${argv.join(" ")} exited ${exitCode}\n${stderr}${stdout}`);
  }
  return stdout;
}

describe("fleet --help", () => {
  test("every help route PRINTS the signposted text, byte for byte", async () => {
    // `--help`, `-h` and the bare verb. The first two used to die with
    // `fleet action must be one of: …` — the one answer that helps nobody,
    // since the operator was asking which actions exist.
    for (const argv of [["fleet", "--help"], ["fleet", "-h"], ["fleet"]]) {
      expect(await cliStdout(...argv)).toBe(FLEET_USAGE);
    }
    // …and an action that really is unknown still says so.
    await expect(cliStdout("fleet", "bogus")).rejects.toThrow(/fleet action must be one of/);
  }, 120_000);

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
