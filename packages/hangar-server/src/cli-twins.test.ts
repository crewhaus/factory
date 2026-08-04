/**
 * HM-192 — the CLI twin, checked against the CLI.
 *
 * Every M4 surface that shows a command shows it as "the exact command that
 * does the same thing in a terminal". That claim is the console's single
 * best trust affordance, and it is only worth anything if the command runs:
 * a twin that fails when pasted teaches an operator that the console's
 * commands are decorative, which is worse than showing none at all.
 *
 * Two twins shipped that the CLI rejects — `crewhaus daemon <verb> --dir
 * <path>` (the daemon takes the harness POSITIONALLY, and its flag parser
 * hard-rejects unknown flags on every verb) and `crewhaus harness scan-root
 * add <dir>` (there is no `scan-root` verb; the equivalent is `harness scan
 * --root <dir>`, which remembers the root). Both were rendered beside a copy
 * button, one of them on the first screen a new operator ever sees.
 *
 * So this file validates the twins the SERVER emits against the CLI's own
 * dispatch, two ways:
 *
 *   1. a table of accepted nouns → verbs → flags, transcribed from
 *      `apps/cli/src/{harness,daemon}-cmd.ts`; and
 *   2. a drift guard that re-reads those files and fails if the dispatch
 *      grew or lost a verb without this table following — because a table
 *      that silently goes stale is the same defect one layer up.
 *
 * The CLI is not imported: `apps/cli` depends on this package, not the other
 * way round, and a test that inverted that would be a layering violation the
 * build would have to be bent around.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { actionCliTwins, matchActions } from "./omnibox";
import { demoAvailability, onboardingView } from "./onboarding";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

/** Repo root, from this file. Only the CLI SOURCE is read (never imported),
 *  and only by the drift guard below. */
const CLI_SRC = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src");

/**
 * What `crewhaus <noun> <verb>` accepts.
 *
 *   · harness — `apps/cli/src/harness-cmd.ts`, the `switch (verb)` dispatch
 *     and each verb's `parseVerbArgs` spec.
 *   · daemon  — `apps/cli/src/daemon-cmd.ts`, `DAEMON_VERBS` and the same.
 *
 * Flags are listed per verb because `parseVerbArgs` THROWS on any flag
 * outside the verb's own spec — an unknown flag is not ignored, it is a
 * non-zero exit with an "unknown flag" message.
 */
const CLI_DISPATCH: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  harness: {
    list: ["group", "json"],
    show: ["json"],
    add: [],
    remove: [],
    relocate: [],
    group: ["add", "remove", "color", "order"],
    tag: ["add", "remove"],
    pin: ["off"],
    scan: ["root"],
    preflight: ["json"],
  },
  daemon: {
    start: ["force", "ack", "no-preflight"],
    restart: ["force", "ack", "no-preflight"],
    stop: ["grace"],
    status: ["json"],
    logs: ["tail", "follow", "run"],
    wake: ["lane", "reason"],
    drain: [],
  },
};

/** A twin may be a `&&` chain (`cp -R … && crewhaus harness add <dir>`), and
 *  may carry a trailing `# comment`. Pull out the `crewhaus …` commands. */
function crewhausCommands(twin: string): readonly string[] {
  return twin
    .split("&&")
    .map((part) => part.replace(/#.*$/, "").trim())
    .filter((part) => part.startsWith("crewhaus "));
}

/** Why this command would fail if pasted, or null when it would run. */
function rejectionReason(command: string): string | null {
  // Shell-quoted paths are one token to the shell; the grammar check only
  // needs the leading words and the flags, so drop quoted runs wholesale.
  const tokens = command
    .replace(/'[^']*'/g, "<quoted>")
    .split(/\s+/)
    .slice(1);
  const [noun, verb, ...rest] = tokens;
  if (noun === undefined) return "bare `crewhaus` with no noun";
  const verbs = CLI_DISPATCH[noun];
  // Only the nouns this file claims to police; anything else is out of scope
  // rather than silently blessed.
  if (verbs === undefined) return `no dispatch table for \`crewhaus ${noun}\``;
  if (verb === undefined) return `\`crewhaus ${noun}\` with no verb`;
  const flags = verbs[verb];
  if (flags === undefined) {
    return `unknown ${noun} verb "${verb}" (expected: ${Object.keys(verbs).join(" | ")})`;
  }
  for (const token of rest) {
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=")[0] as string;
    if (!flags.includes(name)) {
      return `${noun} ${verb}: unknown flag "--${name}" (expected: ${
        flags.length === 0 ? "none" : flags.map((f) => `--${f}`).join(", ")
      })`;
    }
  }
  return null;
}

/** Assert one twin would run, naming the twin AND the reason on failure. */
function expectRunnable(label: string, twin: string): void {
  const commands = crewhausCommands(twin);
  expect(`${label}: ${commands.length > 0}`).toBe(`${label}: true`);
  for (const command of commands) {
    expect(`${label} ⇒ ${command} ⇒ ${rejectionReason(command) ?? "runs"}`).toBe(
      `${label} ⇒ ${command} ⇒ runs`,
    );
  }
}

describe("the dispatch table matches the CLI", () => {
  test("every harness and daemon verb the CLI accepts is in the table, and vice versa", () => {
    // The table above is a transcription, and a transcription rots. This is
    // the guard that makes it fail loudly instead.
    const harnessSrc = readFileSync(join(CLI_SRC, "harness-cmd.ts"), "utf8");
    const daemonSrc = readFileSync(join(CLI_SRC, "daemon-cmd.ts"), "utf8");

    // `unknown harness verb "${verb}" (expected: list | show | …)`
    const harnessExpected = harnessSrc.match(/unknown harness verb[^(]*\(expected: ([^)]+)\)/);
    expect(harnessExpected?.[1]).toBeDefined();
    expect((harnessExpected?.[1] ?? "").split("|").map((v) => v.trim())).toEqual(
      Object.keys(CLI_DISPATCH["harness"] as Record<string, readonly string[]>),
    );

    // `export const DAEMON_VERBS = ["start", "stop", …] as const;`
    const daemonList = daemonSrc.match(/export const DAEMON_VERBS = \[([^\]]+)\]/);
    expect(daemonList?.[1]).toBeDefined();
    const daemonVerbs = [...(daemonList?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect([...daemonVerbs].sort()).toEqual(
      Object.keys(CLI_DISPATCH["daemon"] as Record<string, readonly string[]>).sort(),
    );
  });

  test("the checker actually rejects the two commands that shipped", () => {
    // A validator that passes everything proves nothing.
    expect(rejectionReason("crewhaus daemon start --dir /h/poly")).toContain(
      'unknown flag "--dir"',
    );
    expect(rejectionReason("crewhaus daemon stop --dir /h/poly")).toContain("--grace");
    expect(rejectionReason("crewhaus harness scan-root add /h")).toContain(
      'unknown harness verb "scan-root"',
    );
    // …and accepts the corrected forms.
    expect(rejectionReason("crewhaus daemon start '/srv/my harnesses/poly'")).toBeNull();
    expect(rejectionReason("crewhaus harness scan --root <dir>")).toBeNull();
  });
});

describe("every twin this server proposes would run if pasted", () => {
  test("the omnibox action twins", () => {
    for (const twin of actionCliTwins("/srv/harnesses/poly")) {
      expectRunnable("omnibox", twin);
      // The regression, named: the harness is positional, never `--dir`.
      expect(twin).not.toContain("--dir");
    }
    // A path with a space is quoted, or the shell splits it and the command
    // targets a different directory than the row the operator confirmed.
    const spaced = matchActions("restart poly", [
      { id: "hrn_00000000000000a1", specName: "poly", dir: "/srv/my harnesses/poly" },
    ]);
    expect(spaced[0]?.cliTwin).toBe("crewhaus daemon restart '/srv/my harnesses/poly'");
    expectRunnable("omnibox (spaced path)", spaced[0]?.cliTwin ?? "");
  });

  test("the onboarding twins — the first screen a new operator sees", () => {
    const twins = onboardingView({
      harnessCount: 0,
      scanRootCount: 0,
      suggestions: [],
      demo: demoAvailability({}),
      completedAt: null,
    }).cliTwins;
    expect(Object.keys(twins).length).toBeGreaterThan(3);
    for (const [name, twin] of Object.entries(twins)) expectRunnable(`onboarding.${name}`, twin);
    // The `scan-root` verb does not exist and never did.
    expect(Object.values(twins).some((t) => t.includes("scan-root"))).toBe(false);
  });

  test("and the same is true of what the ROUTES actually serve", async () => {
    // The pure functions are the source, but the payload is what the console
    // renders — so the sweep runs over the served documents too.
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "twinned");
      makeFixtureHarness(dir, { specName: "twinned" });
      await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });

      const onboarding = (await t.api("/api/onboarding")).body["cliTwins"] as Record<
        string,
        string
      >;
      for (const [name, twin] of Object.entries(onboarding)) {
        expectRunnable(`GET /api/onboarding ${name}`, twin);
      }

      const notifications = (await t.api("/api/notifications")).body["cliTwin"] as string;
      expectRunnable("GET /api/notifications", notifications);

      const search = (await t.api("/api/search?q=start%20twinned")).body["actions"] as Array<{
        id: string;
        cliTwin: string;
      }>;
      expect(search.length).toBeGreaterThan(0);
      for (const action of search) expectRunnable(`GET /api/search ${action.id}`, action.cliTwin);
    } finally {
      await t.stop();
    }
  }, 20_000);
});
