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
 *      `apps/cli/src/{harness,daemon}-cmd.ts` and, for the memory screens'
 *      commands, `apps/cli/src/{index,arg-schemas,dream-cli}.ts`; and
 *   2. a drift guard that re-reads those files and fails if the dispatch
 *      grew or lost a verb without this table following — because a table
 *      that silently goes stale is the same defect one layer up.
 *
 * The CLI is not imported: `apps/cli` depends on this package, not the other
 * way round, and a test that inverted that would be a layering violation the
 * build would have to be bent around.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { COMMAND_KINDS, OPERATIONS, renderTwin } from "@crewhaus/control-contract";
import { createWikiStore } from "@crewhaus/wiki-store";
import { MAX_FACT_FILE_BYTES } from "./constants";
import { makeFixtureHarness } from "./fixture";
import { M3_ROUTES } from "./m3-routes";
import { actionCliTwins, matchActions } from "./omnibox";
import { demoAvailability, onboardingView } from "./onboarding";
import { ROUTE_TABLE } from "./route-table";
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
 *   · memory, wiki, knowledge, dream, migrate, watchme — the dispatch in
 *     `apps/cli/src/index.ts`, with one flag schema per noun
 *     (`arg-schemas.ts`, `DREAM_CLI_SCHEMA` in `dream-cli.ts`).
 *   · state — `STATE_SCHEMA` in `apps/cli/src/arg-schemas.ts`, one flag list
 *     across backup, restore, clear and trash, and the `state` dispatch in
 *     `apps/cli/src/index.ts`.
 *   · approvals — `APPROVALS_SCHEMA` in `apps/cli/src/arg-schemas.ts`, one flag
 *     list across its verbs, and the action list in `apps/cli/src/index.ts`.
 *
 * Flags are listed per verb because `parseVerbArgs` THROWS on any flag
 * outside the verb's own spec — an unknown flag is not ignored, it is a
 * non-zero exit with an "unknown flag" message. A noun with one schema accepts
 * the same flags on every verb.
 */
const MEMORY_FLAGS = [
  "spec",
  "query",
  "yes",
  "compact",
  "help",
  "reason",
  "text",
  "text-file",
  "personal",
  "not-personal",
];
const WIKI_FLAGS = [
  "spec",
  "tags",
  "status",
  "k",
  "help",
  "body-file",
  "expect",
  "title",
  "undo",
  "to",
];
const STATE_FLAGS = [
  "out",
  "exclude",
  "into",
  "merge",
  "force",
  "help",
  "scope",
  "session",
  "spec",
  "yes",
  "expect",
  "trash",
];
const KNOWLEDGE_FLAGS = ["root", "shared", "pull", "push", "dry-run", "no-redact", "help"];
const DREAM_FLAGS = ["force", "help"];
const MIGRATE_MEMORIES_FLAGS = ["dry-run", "help"];
const WATCHME_FLAGS = [
  "spec",
  "root",
  "session",
  "all",
  "out",
  "json",
  "name",
  "force",
  "interactive",
  "propose",
  "feed-routing",
  "emit-feedback",
  "no-model",
  "dry-run",
  "forget",
  "help",
];
const APPROVALS_FLAGS = ["dir", "by", "once", "always", "reason", "until", "json", "help"];

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
    start: ["force", "ack", "no-preflight", "compile", "no-compile"],
    submit: ["brief-file", "force", "ack", "no-preflight", "compile", "no-compile"],
    restart: ["force", "ack", "no-preflight", "compile", "no-compile"],
    stop: ["grace"],
    status: ["json"],
    logs: ["tail", "follow", "run"],
    wake: ["lane", "reason"],
    drain: [],
  },
  memory: {
    list: MEMORY_FLAGS,
    show: MEMORY_FLAGS,
    forget: MEMORY_FLAGS,
    sweep: MEMORY_FLAGS,
    correct: MEMORY_FLAGS,
    mark: MEMORY_FLAGS,
  },
  wiki: {
    list: WIKI_FLAGS,
    show: WIKI_FLAGS,
    search: WIKI_FLAGS,
    stats: WIKI_FLAGS,
    write: WIKI_FLAGS,
    archive: WIKI_FLAGS,
    rollback: WIKI_FLAGS,
  },
  state: { backup: STATE_FLAGS, restore: STATE_FLAGS, clear: STATE_FLAGS, trash: STATE_FLAGS },
  knowledge: { sync: KNOWLEDGE_FLAGS },
  dream: { run: DREAM_FLAGS, status: DREAM_FLAGS, init: DREAM_FLAGS },
  migrate: { memories: MIGRATE_MEMORIES_FLAGS },
  watchme: {
    start: WATCHME_FLAGS,
    stop: WATCHME_FLAGS,
    status: WATCHME_FLAGS,
    report: WATCHME_FLAGS,
    intents: WATCHME_FLAGS,
    synthesize: WATCHME_FLAGS,
    publish: WATCHME_FLAGS,
  },
  approvals: {
    list: APPROVALS_FLAGS,
    show: APPROVALS_FLAGS,
    grant: APPROVALS_FLAGS,
    deny: APPROVALS_FLAGS,
    supersede: APPROVALS_FLAGS,
    defer: APPROVALS_FLAGS,
  },
};

/** The flag names one `ParseArgsSchema` constant declares, read from source. */
function schemaFlags(source: string, schema: string): readonly string[] {
  const start = source.indexOf(`export const ${schema}: ParseArgsSchema = {`);
  expect(`${schema}: ${start >= 0}`).toBe(`${schema}: true`);
  const block = source.slice(start, source.indexOf("\n};", start));
  return [...block.matchAll(/\{ name: "([a-z-]+)"/g)].map((m) => m[1] as string);
}

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

  test("the memory screens' nouns match the CLI's own lists", () => {
    const index = readFileSync(join(CLI_SRC, "index.ts"), "utf8");
    const verbsOf = (noun: string): readonly string[] =>
      Object.keys(CLI_DISPATCH[noun] as Record<string, readonly string[]>);

    const memory = index.match(/memory: unknown action [^\n]*supported: ([a-z, ]+)`/);
    expect(memory?.[1]?.split(", ")).toEqual([...verbsOf("memory")]);
    const wiki = index.match(/wiki: unknown action [^\n]*supported: ([a-z, ]+)`/);
    expect(wiki?.[1]?.split(", ")).toEqual([...verbsOf("wiki")]);
    const state = index.match(/state action must be one of ([a-z, ]+) \(got/);
    expect(state?.[1]?.split(", ")).toEqual([...verbsOf("state")]);
    expect(index).toContain('knowledge action must be "sync"');
    expect(verbsOf("knowledge")).toEqual(["sync"]);
    expect(index).toContain(
      'dreamFirst === "run" || dreamFirst === "status" || dreamFirst === "init"',
    );
    expect(verbsOf("dream")).toEqual(["run", "status", "init"]);
    expect(index).toContain('migrate action must be "memories"');
    expect(verbsOf("migrate")).toEqual(["memories"]);
    const watchme = index.match(/const allowed = \["", ([^\]]+)\];/);
    expect([...(watchme?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual([
      ...verbsOf("watchme"),
    ]);
  });

  test("their flags match the CLI's own schemas", () => {
    const schemas = readFileSync(join(CLI_SRC, "arg-schemas.ts"), "utf8");
    const dream = readFileSync(join(CLI_SRC, "dream-cli.ts"), "utf8");
    expect(schemaFlags(schemas, "MEMORY_SCHEMA")).toEqual(MEMORY_FLAGS);
    expect(schemaFlags(schemas, "WIKI_SCHEMA")).toEqual(WIKI_FLAGS);
    expect(schemaFlags(schemas, "STATE_SCHEMA")).toEqual(STATE_FLAGS);
    expect(schemaFlags(schemas, "KNOWLEDGE_SCHEMA")).toEqual(KNOWLEDGE_FLAGS);
    expect(schemaFlags(schemas, "MIGRATE_MEMORIES_SCHEMA")).toEqual(MIGRATE_MEMORIES_FLAGS);
    expect(schemaFlags(schemas, "WATCHME_SCHEMA")).toEqual(WATCHME_FLAGS);
    expect(schemaFlags(dream, "DREAM_CLI_SCHEMA")).toEqual(DREAM_FLAGS);
  });

  test("the checker rejects the memory commands that never existed", () => {
    expect(rejectionReason("crewhaus memory remember")).toContain('unknown memory verb "remember"');
    expect(rejectionReason("crewhaus remember")).toContain("no dispatch table");
    expect(rejectionReason("crewhaus wiki delete")).toContain('unknown wiki verb "delete"');
    // `wiki write` exists now, with its own flags.
    expect(rejectionReason("crewhaus wiki write <slug> --body-file <file> --expect 0")).toBeNull();
    expect(rejectionReason("crewhaus state trash")).toBeNull();
    expect(rejectionReason("crewhaus run (then /reflect)")).toContain("no dispatch table");
    expect(rejectionReason("crewhaus memory list --nope")).toContain('unknown flag "--nope"');
    // …and accepts the forms the screens show.
    expect(rejectionReason("crewhaus memory list --spec fabric")).toBeNull();
    expect(rejectionReason("crewhaus dream init crewhaus.yaml")).toBeNull();
  });

  test("the approvals verbs and flags are the ones the CLI declares", () => {
    const schemas = readFileSync(join(CLI_SRC, "arg-schemas.ts"), "utf8");
    expect(schemaFlags(schemas, "APPROVALS_SCHEMA")).toEqual(APPROVALS_FLAGS);

    const entry = readFileSync(join(CLI_SRC, "index.ts"), "utf8");
    const actions = entry.match(
      /!isHelp && !\["", ([^\]]+)\]\.includes\(action\)[^\n]*\n\s*die\(\s*`approvals/,
    );
    expect(actions?.[1]).toBeDefined();
    const verbs = [...(actions?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(verbs).toEqual(
      Object.keys(CLI_DISPATCH["approvals"] as Record<string, readonly string[]>),
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

  test("every verb the memory reads answer with, empty or filled", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const reads = M3_ROUTES.filter((r) => r.method === "GET" && r.path.includes("/memory/"));
      const emptyDir = makeFixtureHarness(join(t.harnessesRoot, "bare"), { specName: "bare" });
      const filledDir = makeFixtureHarness(join(t.harnessesRoot, "filled"), {
        specName: "filled",
        specExtra: "memory:\n  dream:\n    every: 24h",
      });
      const stores = { rootDir: join(filledDir, ".crewhaus", "wiki"), specName: "filled" };
      await createWikiStore(stores).write({ slug: "one", title: "One", body: "first" });
      await createWikiStore(stores).write({
        slug: "one",
        title: "One",
        body: "second",
        expectedVersion: 1,
      });
      await createContinuityStore({
        specName: "filled",
        rootDir: join(filledDir, ".crewhaus", "state"),
        sessionRootDir: join(filledDir, ".crewhaus", "sessions"),
      }).writeFocus("ship it");
      const memories = join(filledDir, ".crewhaus", "memories");
      mkdirSync(memories, { recursive: true });
      const big = join(memories, "big.jsonl");
      writeFileSync(big, "");
      truncateSync(big, MAX_FACT_FILE_BYTES + 1);

      const seen: string[] = [];
      for (const [dir, spec] of [
        [emptyDir, "bare"],
        [filledDir, "big"],
      ] as const) {
        const { body } = await t.api("/api/harnesses", {
          method: "POST",
          body: JSON.stringify({ dir }),
        });
        const id = (body["entry"] as { id: string }).id;
        for (const route of reads) {
          const url = route.path
            .replace(":id", id)
            .replace(":spec", spec)
            .replace(":slug", "one")
            .replace(":version", "1")
            .replace(":stamp", "20260101");
          const res = await t.api(url);
          expect(`${url} ${res.status}`).toBe(`${url} 200`);
          const verb = res.body["verb"];
          if (typeof verb !== "string") continue;
          expectRunnable(`${route.key} on ${spec}`, verb);
          seen.push(`${route.key}: ${verb}`);
        }
      }
      // Pinned, so this guard cannot go quiet: fifteen reads swept twice. The
      // trash list (on both harnesses) and the empty wiki now name their verbs.
      expect(reads.length).toBe(15);
      expect(seen.length).toBe(18);
      expect(seen.filter((v) => v.endsWith(": crewhaus state trash"))).toHaveLength(2);
      expect(
        seen.filter((v) =>
          v.endsWith(": crewhaus wiki write <slug> --body-file <file> --expect 0"),
        ),
      ).toHaveLength(1);
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("every twin the contract declares would run if pasted", () => {
  const SAMPLES = [
    {
      hrn: "hrn_0123456789abcdef",
      appr: "appr_0123456789abcdef",
      dir: "/srv/poly",
      choice: "grant",
    },
    {
      hrn: "hrn_0123456789abcdef",
      appr: "appr_0123456789abcdef",
      dir: "/srv/poly",
      choice: "deny",
    },
  ];

  test("operations and command kinds, both choices", () => {
    const twins = [
      ...OPERATIONS.map((op) => [op.id, op.cliTwin] as const),
      ...Object.values(COMMAND_KINDS).map((kind) => [kind.id, kind.cliTwin] as const),
      ...ROUTE_TABLE.flatMap((row) =>
        row.cliTwin !== null ? [[row.key, row.cliTwin] as const] : [],
      ),
    ];
    let checked = 0;
    for (const [id, twin] of twins) {
      if (twin === null) continue;
      for (const sample of SAMPLES) {
        const rendered = renderTwin(twin, sample);
        if (!("argv" in rendered)) throw new Error(`${id}: ${JSON.stringify(rendered)}`);
        expectRunnable(id, `crewhaus ${rendered.argv.join(" ")}`);
        checked++;
      }
    }
    // Eight operation twins, five command kinds and seven route rows, each rendered twice.
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  test("the checker refuses a verb the CLI does not have", () => {
    expect(rejectionReason("crewhaus approvals revoke appr_x")).toContain(
      'unknown approvals verb "revoke"',
    );
  });
});
