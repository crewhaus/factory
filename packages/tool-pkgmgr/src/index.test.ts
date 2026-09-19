/**
 * The tool halves: what PackageQuery and PackageInstall actually RUN, and what
 * they refuse.
 *
 * `lib.test.ts` covers the parsers and the name gate against recorded output.
 * This file drives the two tools through the runner seam and asserts on the
 * RECORDED ARGV, because the safety claims here are claims about what reaches
 * a command line:
 *
 *   - no caller-supplied string becomes an argument unless the name gate
 *     passed it, and a value that would become a flag is separated by `--`;
 *   - nothing this package runs is an escalation binary, and no schema has a
 *     field to pass a password to — the same shape `tool-onchain` uses to
 *     prove no schema accepts a private key;
 *   - a manager that needs root REFUSES and hands back the command an operator
 *     would run themselves, while Homebrew, which does not need root, proceeds;
 *   - `dryRun` resolves through the SAME code as the real install rather than a
 *     parallel preview that can drift — asserted as a prefix relationship, not
 *     by reading the source.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetHostSeams, _setPlatform, _setUid } from "./host";
import { packageInstall, packageQuery } from "./index";
import { _setRunner } from "./run";

let argvSeen: Array<{ cmd: string; args: readonly string[] }> = [];
beforeEach(() => {
  argvSeen = [];
  _setPlatform("linux");
  _setUid(1000);
  _setRunner(async (request: { readonly argv: readonly string[] }) => {
    const [cmd = "", ...args] = request.argv;
    argvSeen.push({ cmd, args });
    return { code: 0, stdout: "", stderr: "" } as never;
  });
});
afterEach(() => {
  _resetHostSeams();
  _setRunner(undefined);
});

const HOSTILE = [
  "curl; rm -rf ~",
  "curl && id",
  "curl | tee /etc/passwd",
  "-rf",
  "--force",
  "--",
  "curl$(id)",
  "curl`id`",
  "curl\nid",
  "curl\u0000id",
  "../../etc/passwd",
  "curl'",
  'curl"',
  "a".repeat(5000),
];

test("no hostile package name ever reaches an argv element", async () => {
  const leaked: string[] = [];
  for (const name of HOSTILE) {
    argvSeen = [];
    for (const tool of [packageQuery, packageInstall]) {
      try {
        await tool.execute({ manager: "apt", name } as never);
      } catch {
        /* a refusal is the expected outcome */
      }
    }
    for (const { cmd, args } of argvSeen) {
      // EXACT element comparison, not substring: `--` is a legitimate
      // separator and a substring of `--version`, so a substring test reports
      // the tool's own correct flag as a leak. What matters is whether the
      // caller's string became an argument, which is an identity question.
      if (cmd === name || args.includes(name)) {
        leaked.push(`${name} -> ${cmd} ${args.join(" ")}`);
      }
    }
  }
  console.log(`ARGVLEAKS=${leaked.length} ${leaked.slice(0, 4).join(" ;; ")}`);
  expect(leaked).toEqual([]);
});

test("nothing this tool runs is an escalation binary", async () => {
  argvSeen = [];
  for (const tool of [packageQuery, packageInstall]) {
    for (const manager of ["apt", "dnf", "pacman", "homebrew"]) {
      try {
        await tool.execute({ manager, name: "curl" } as never);
      } catch {
        /* platform/manager refusals are fine */
      }
    }
  }
  const bad = argvSeen.filter(
    ({ cmd, args }) =>
      /^(sudo|doas|runas|pkexec|gksudo)$/.test(cmd) ||
      args.some((a) => /^(sudo|doas|runas|pkexec)$/.test(a)),
  );
  console.log(`RAN=${argvSeen.length} ESCALATIONS=${bad.length}`);
  for (const a of argvSeen.slice(0, 8)) console.log(`  CMD ${a.cmd} ${a.args.join(" ")}`);
  expect(argvSeen.length).toBeGreaterThan(0);
  expect(bad).toEqual([]);
});

test("no schema accepts a password or an escalation flag", () => {
  for (const tool of [packageQuery, packageInstall]) {
    const shape = JSON.stringify(tool.inputSchema);
    for (const field of ["password", "sudo", "become", "runAs", "elevate", "privileged"]) {
      expect({ tool: tool.name, field, present: shape.includes(field) }).toEqual({
        tool: tool.name,
        field,
        present: false,
      });
    }
  }
});

test("apt refuses to install as an ordinary user and names the command to run", async () => {
  _setPlatform("linux");
  _setUid(1000);
  const out = String(await packageInstall.execute({ manager: "apt", name: "curl" } as never));
  console.log(`APT_NONROOT ${out.slice(0, 260)}`);
  // The REASON, not merely a failure: an assertion that only checks "it did
  // not install" is satisfied by a crash, a timeout or a missing binary.
  expect(out).toMatch(/root|privilege|elevat/i);
  // ...and it must hand the operator something they can actually run.
  expect(out).toMatch(/sudo apt-get install/);
  // Nothing was actually installed. `apt-get install -s` DOES appear, and is
  // correct: `-s` is simulate, the dry run apt itself provides to resolve the
  // plan. What must be absent is an install without it.
  const real = argvSeen.filter(
    (a) => a.args.includes("install") && !a.args.includes("-s") && !a.args.includes("--simulate"),
  );
  expect(real).toEqual([]);
});

test("homebrew, which needs no root, is allowed to proceed as that same user", async () => {
  _setPlatform("darwin");
  _setUid(1000);
  argvSeen = [];
  try {
    await packageInstall.execute({ manager: "homebrew", name: "curl" } as never);
  } catch {
    /* the stub runner returns empty output; we only care what it TRIED */
  }
  const tried = argvSeen.map((a) => `${a.cmd} ${a.args.join(" ")}`);
  console.log(`BREW_TRIED ${tried.slice(0, 4).join(" ;; ")}`);
  // The distinction is the point: root-needing managers refuse, brew does not.
  expect(argvSeen.length).toBeGreaterThan(0);
  expect(tried.some((t) => /^sudo /.test(t))).toBe(false);
});

test("dryRun resolves through the same code the real install uses", async () => {
  _setPlatform("darwin");
  _setUid(1000);
  argvSeen = [];
  try {
    await packageInstall.execute({ manager: "homebrew", name: "curl", dryRun: true } as never);
  } catch {
    /* ignore */
  }
  const dry = argvSeen.map((a) => `${a.cmd} ${a.args.join(" ")}`);
  argvSeen = [];
  try {
    await packageInstall.execute({ manager: "homebrew", name: "curl" } as never);
  } catch {
    /* ignore */
  }
  const real = argvSeen.map((a) => `${a.cmd} ${a.args.join(" ")}`);
  console.log(`DRY ${dry.join(" ;; ")}`);
  console.log(`REAL ${real.join(" ;; ")}`);
  // A dryRun that resolves through a PARALLEL path can drift from the real one
  // — that happened in tool-hostfs, where a preview predicted a destination the
  // real call never used. The real run must do everything the dry run did, in
  // the same order, and then more.
  expect(dry.length).toBeGreaterThan(0);
  expect(real.slice(0, dry.length)).toEqual(dry);
  expect(real.length).toBeGreaterThanOrEqual(dry.length);
});
