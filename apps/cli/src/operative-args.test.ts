/**
 * 0.7.1 — every builtin that can change something, or reaches outside the
 * process, says which of its arguments decides WHERE it acts.
 *
 * `operativeArgs` is what a scoped permission rule (`Write(src/**)`,
 * `HttpRequest(https://api.example.com/**)`) is checked against, what
 * `crewhaus permissions suggest` scopes a proposal on, and what tells the
 * egress fabric a tool sends to a destination the model picked. A tool that
 * declares nothing falls back to matching every string in its input, which
 * is safe for a deny but makes a scoped allow almost impossible to write and
 * leaves the egress fabric guessing.
 *
 * The scope of this guard is the live registry — every tool
 * `BUILTIN_TOOL_MAP` compiles in, loaded the way a bundle loads it — never
 * a list of names. The one list here is the EXPECTED set of tools that
 * declare `[]` ("no argument decides where this acts"): declaring nothing is
 * allowed, but it has to be a decision somebody wrote down, so a new `[]`
 * fails until it is added with its reason.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

let builtins: ReadonlyArray<RegisteredTool>;
beforeAll(async () => {
  const loaded: RegisteredTool[] = [];
  for (const entry of Object.values(BUILTIN_TOOL_MAP)) {
    const mod = (await import(entry.package)) as Record<string, unknown>;
    const tool = mod[entry.export] as RegisteredTool | undefined;
    if (tool !== undefined) loaded.push(tool);
  }
  builtins = loaded;
}, 60_000);

/** The tools this guard covers: anything not read-only, and anything external. */
function inScope(): RegisteredTool[] {
  return builtins.filter((t) => !t.readOnly || t.scope === "external");
}

/**
 * The builtins that declare `[]`, each with the reason no argument scopes
 * it. Adding a tool here is the review step; the test below fails until
 * this matches the registry exactly.
 */
const NO_SCOPING_ARGUMENT: Readonly<Record<string, string>> = {
  AlertList: "queries the configured alerting backend; the filter selects alerts, not a place",
  BashOutput: "reads a shell this session started, by a handle only this session has",
  ClipboardRead: "the clipboard is the only place it reads",
  ClipboardWrite: "the clipboard is the only place it writes",
  CronList: "lists the machine's schedulers; nothing selects a place",
  DesktopNotify: "the local notification centre is the only destination",
  EntityRegistryLookup: "asks fixed public registries; the identifiers select a record",
  ImageGenerate: "sends a prompt to the configured image provider",
  KillShell: "stops a shell this session started, by a handle only this session has",
  LogsQuery: "queries the configured log backend",
  MetricsQuery: "queries the configured metrics backend",
  NetworkInfo: "reads this machine's network configuration",
  PortInspect: "reads this machine's listening sockets",
  PowerAssertion: "holds or releases this machine's sleep assertion",
  PriceQuote: "asks fixed public price providers",
  ProcessOutput: "reads a process this session started, by a handle only this session has",
  ProcessStop: "stops a process this session started, by a handle only this session has",
  RateLimitStatus: "reads the configured code host's own rate limit",
  RegistrySearch: "searches a fixed public package registry",
  SystemInfo: "reads this machine's hardware and OS facts",
  TodoWrite: "writes this session's own task list",
  UserPresence: "reads this machine's idle time",
  VatIdValidate: "asks the fixed VIES service",
  WindowList: "lists this machine's windows",
};

describe("every non-read-only or external builtin declares operativeArgs", () => {
  test("the sweep reads the real registry", () => {
    // The guard's own hit count: a sweep that finds nothing passes.
    expect(builtins.length).toBeGreaterThanOrEqual(500);
    expect(inScope().length).toBeGreaterThanOrEqual(220);
    const names = new Set(inScope().map((t) => t.name));
    for (const known of ["Write", "HttpRequest", "RunCommand", "GitCommit", "HttpPaginate"]) {
      expect(names.has(known)).toBe(true);
    }
  });

  test("none leaves operativeArgs out", () => {
    const undeclared = inScope()
      .filter((t) => t.operativeArgs === undefined)
      .map((t) => t.name)
      .sort();
    expect(undeclared).toEqual([]);
  });

  test("the tools that declare no scoping argument are exactly the reviewed ones", () => {
    const empty = inScope()
      .filter((t) => t.operativeArgs !== undefined && t.operativeArgs.length === 0)
      .map((t) => t.name)
      .sort();
    expect(empty).toEqual(Object.keys(NO_SCOPING_ARGUMENT).sort());
  });

  test("a tool that writes files names at least one path", () => {
    // `destructive` + a declared path is how a rule reaches a file write; a
    // destructive tool whose only declared field is not a path would leave
    // `Write(src/**)`-style rules nothing to read. Derived, not listed: every
    // destructive internal tool with a string field named like a path.
    const pathish = /(^|\.)(path|paths|file|out|output|outFile|destination|database|dbPath)$/;
    const offenders: string[] = [];
    let checked = 0;
    for (const tool of inScope()) {
      if (!tool.destructive || tool.scope === "external") continue;
      const declared = tool.operativeArgs ?? [];
      const fields = Object.keys(
        ((tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {}) as object,
      );
      if (!fields.some((f) => pathish.test(f))) continue;
      checked++;
      if (!declared.some((a) => a.kind === "path")) offenders.push(tool.name);
    }
    expect(checked).toBeGreaterThanOrEqual(40);
    expect(offenders).toEqual([]);
  });
});
