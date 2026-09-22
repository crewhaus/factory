/**
 * The tool halves: what these eight tools actually RUN, and what they refuse.
 *
 * `lib.test.ts` covers the parsers against recorded output. This file drives
 * every tool through the runner seam and asserts on the RECORDED ARGV,
 * because the safety claims in this package are claims about what reaches a
 * command line and what reaches a compiler:
 *
 *   - a caller's string is never part of PROGRAM TEXT. For osascript that
 *     means it appears only after `--`, never in an `-e` statement; for
 *     PowerShell it means it is not in the argv at all, because it travels in
 *     the environment;
 *   - a value that would be read as a FLAG is either separated by `--` or
 *     refused outright, per program, because `lp` and `xdg-open` have no `--`;
 *   - nothing this package runs is an escalation binary and no schema has a
 *     field to pass a password to;
 *   - every tool answers a headless host with a typed `unavailable`, never a
 *     throw and never a `false` that reads as an answer;
 *   - `dryRun` resolves through the SAME code as the real path — asserted as
 *     a prefix relationship over the recorded argv, not by reading the source.
 *
 * Every test here drives a recorded runner. The un-injected platform is
 * `"unsupported"` (see ../host.ts), so a test that forgot the seam would fail
 * identically on macOS and on the Linux CI box rather than inheriting whoever
 * ran it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LPSTAT_STDOUT, PS_CAFFEINATE_STDOUT, PS_REUSED_PID_STDOUT } from "./fixtures";
import {
  HEADLESS_ENV,
  type SessionEnv,
  _resetHostSeams,
  _setClock,
  _setPlatform,
  _setSessionEnv,
} from "./host";
import {
  clipboardRead,
  clipboardWrite,
  desktopNotify,
  openExternal,
  powerAssertion,
  printDocument,
  userPresence,
  windowList,
} from "./index";
import { POWERSHELL_FLAGS, osascriptProgramText, registeredPowerShellSources } from "./lib/escape";
import { type HostFs, type PathFacts, _setFs } from "./lib/fsseam";
import { type RunRequest, type RunResult, _resetRunSeams, _setDetacher, _setRunner } from "./run";

type Recorded = { argv: readonly string[]; env?: Readonly<Record<string, string>>; stdin?: string };

let argvSeen: Recorded[] = [];
let detachSeen: Recorded[] = [];
/** Answers keyed by argv[0]; anything unlisted succeeds with empty output. */
let answers: Record<string, Partial<RunResult>> = {};
let files: Map<string, string>;

const OK: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false, missing: false };

/** An in-memory filesystem, so no test writes a state file into the worktree. */
function memoryFs(stat: (p: string) => PathFacts | undefined): HostFs {
  return {
    stat,
    readText: (p) => files.get(p),
    writeTextAtomic: (p, text) => {
      files.set(p, text);
    },
    remove: (p) => {
      files.delete(p);
    },
  };
}

const PLAIN_FILE: PathFacts = {
  exists: true,
  isDirectory: false,
  isFile: true,
  mode: 0o100644,
  sizeBytes: 12,
};

beforeEach(() => {
  argvSeen = [];
  detachSeen = [];
  answers = {};
  files = new Map();
  _setPlatform("darwin");
  _setSessionEnv(HEADLESS_ENV);
  _setClock(() => 1_700_000_000_000);
  _setFs(memoryFs(() => PLAIN_FILE));
  _setRunner(async (request: RunRequest) => {
    argvSeen.push({
      argv: request.argv,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    });
    const program = request.argv[0] ?? "";
    return { ...OK, ...(answers[program] ?? {}) };
  });
  _setDetacher(async (request: RunRequest) => {
    detachSeen.push({ argv: request.argv });
    return { ok: true, pid: 4242 };
  });
});

afterEach(() => {
  _resetHostSeams();
  _resetRunSeams();
  _setFs(undefined);
});

const X11: SessionEnv = {
  ...HEADLESS_ENV,
  DISPLAY: ":0",
  XDG_SESSION_TYPE: "x11",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
};

/**
 * The injection matrix.
 *
 * Each entry is a value that, interpolated into the wrong place, changes what
 * the machine does rather than what it displays. The AppleScript and XML ones
 * are the point of this package; the flag-shaped ones are the argument
 * injection this repo has already shipped once.
 */
const HOSTILE = [
  '" & (do shell script "id") & "',
  '"; display dialog "pwned"; --',
  'say "hi"',
  "</toast><toast><text>pwned</text></toast>",
  "a & b < c > d",
  "-u",
  "-e",
  "--force",
  "--",
  "-rf",
  "$(id)",
  "`id`",
  "'; rm -rf ~; '",
  "line1\nline2",
  "\u0000truncated",
  "\u0001\u0002control",
  "a".repeat(1_500),
];

/** The argv elements BEFORE the `--` separator — the option positions. */
function optionPositions(argv: readonly string[]): readonly string[] {
  const cut = argv.indexOf("--");
  return cut < 0 ? argv : argv.slice(0, cut);
}

// ---------------------------------------------------------------------------
// escaping — the security boundary
// ---------------------------------------------------------------------------

/**
 * The shapes each hostile value is pushed through, as a function of the value.
 *
 * Each entry runs the SAME call twice — once with a hostile value and once
 * with a benign one — so the two recordings can be compared. That comparison
 * is the assertion; see the test below for why an identity check is not.
 */
const INJECTION_SITES: ReadonlyArray<[string, (v: string) => Promise<unknown>]> = [
  ["notify.title", (v) => desktopNotify.execute({ title: v, body: "b" } as never)],
  ["notify.body", (v) => desktopNotify.execute({ title: "t", body: v } as never)],
  [
    "notify.subtitle",
    (v) => desktopNotify.execute({ title: "t", body: "b", subtitle: v } as never),
  ],
  ["open.target", (v) => openExternal.execute({ target: v } as never)],
  ["clipboard.text", (v) => clipboardWrite.execute({ text: v } as never)],
  ["power.reason", (v) => powerAssertion.execute({ action: "hold", reason: v } as never)],
  ["print.printer", (v) => printDocument.execute({ path: "package.json", printer: v } as never)],
  ["print.ranges", (v) => printDocument.execute({ path: "package.json", pageRanges: v } as never)],
];

const BENIGN = "benignvalue";

/**
 * Are these two argv elements the same template with the caller's value
 * substituted for the benign one?
 *
 * Every position where `value` occurs in `hostile` is tried, and the element
 * passes if removing it and putting `BENIGN` there reproduces `control`
 * exactly. That is a precise question with no substring guesswork, which
 * matters because the hostile values include `-e` and `--` — strings that
 * also appear in these argvs legitimately, as the tool's OWN flags. A
 * longest-common-prefix scheme gets `-e` vs `benignvalue` wrong (they share
 * the trailing "e"); trying each occurrence does not.
 */
function sameTemplate(hostile: string, control: string, value: string): boolean {
  if (hostile === control) return true;
  if (value === "") return false;
  for (let p = 0; p + value.length <= hostile.length; p += 1) {
    if (!hostile.startsWith(value, p)) continue;
    if (control === hostile.slice(0, p) + BENIGN + hostile.slice(p + value.length)) return true;
  }
  return false;
}

test(
  "no hostile value ever becomes program text or changes an option position",
  async () => {
    const leaked: string[] = [];
    // This suite has shipped a vacuous guard before: a scanner that compared
    // nothing and passed. The counters below are asserted at the end, so a
    // refactor that stops the matrix reaching a command line fails HERE
    // rather than silently going green.
    let commandsCompared = 0;
    let elementsCompared = 0;
    let programsInspected = 0;
    for (const platform of ["darwin", "linux", "win32"] as const) {
      _setPlatform(platform);
      _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
      for (const [site, call] of INJECTION_SITES) {
        // The control run first: what this call looks like with nothing
        // hostile in it at all.
        argvSeen = [];
        detachSeen = [];
        files.clear();
        try {
          await call(BENIGN);
        } catch {
          /* a refusal is an acceptable outcome; a LEAK is not */
        }
        const control = [...argvSeen, ...detachSeen];

        for (const value of HOSTILE) {
          argvSeen = [];
          detachSeen = [];
          files.clear();
          try {
            await call(value);
          } catch {
            /* refusals are fine */
          }
          const recorded = [...argvSeen, ...detachSeen];

          // (1) NOTHING the caller sent is ever compiled.
          //     `osascriptProgramText` extracts exactly the `-e` statements
          //     osascript hands to the AppleScript compiler.
          for (const { argv } of recorded) {
            programsInspected += 1;
            const text = osascriptProgramText(argv);
            if (text.includes(value)) {
              leaked.push(`${site} ${JSON.stringify(value)} -> PROGRAM TEXT ${text}`);
            }
          }
          // The Windows equivalent of (1). The script source is the last argv
          // element and is a frozen constant, so it must be BYTE-IDENTICAL to
          // the control run's. Checked as equality rather than as "does it
          // contain the value", because injection into source looks exactly
          // like a legitimate substitution to the template check below.
          for (let i = 0; i < Math.min(recorded.length, control.length); i += 1) {
            const h = recorded[i]?.argv ?? [];
            const c = control[i]?.argv ?? [];
            if ((h[0] ?? "").toLowerCase() !== "powershell.exe") continue;
            if (h[h.length - 1] !== c[c.length - 1]) {
              leaked.push(`${site} ${JSON.stringify(value)} -> POWERSHELL SOURCE CHANGED`);
            }
          }

          // (2) The caller's value occupies a SLOT, and never changes the
          //     command's shape around it.
          //
          //     An identity check ("is this value in an option position?") is
          //     the wrong assertion and this suite got it wrong twice. The
          //     hostile value `-e` is also osascript's own legitimate flag and
          //     `--` is its own legitimate separator, so an identity check
          //     reports the tool's correct argv as a leak; and a program with
          //     no `--` (xdg-open) legitimately carries the value as its last
          //     element, so "not in an option position" is not even the
          //     property. What IS the property: run the same call with a
          //     benign value, and every argv element must be the same TEMPLATE
          //     with one substituted for the other. `sameTemplate` proves that
          //     exactly, with no substring guesswork.
          for (let i = 0; i < Math.min(recorded.length, control.length); i += 1) {
            const h = recorded[i]?.argv ?? [];
            const c = control[i]?.argv ?? [];
            commandsCompared += 1;
            if (h.length !== c.length) {
              leaked.push(
                `${site} ${JSON.stringify(value)} -> ARGV LENGTH ${h.length} vs ${c.length}`,
              );
              continue;
            }
            for (let k = 0; k < h.length; k += 1) {
              elementsCompared += 1;
              if (!sameTemplate(h[k] ?? "", c[k] ?? "", value)) {
                leaked.push(
                  `${site} ${JSON.stringify(value)} -> ELEMENT ${k} ${JSON.stringify(h[k])} vs ${JSON.stringify(c[k])}`,
                );
              }
            }
          }
        }
      }
    }
    console.log(
      `INJECTION_LEAKS=${leaked.length} commands=${commandsCompared} elements=${elementsCompared} programs=${programsInspected} ${leaked.slice(0, 3).join(" ;; ")}`,
    );
    expect(leaked).toEqual([]);
    // The guard fired. Without these three the test above passes on a matrix
    // that reached no command line at all.
    expect(commandsCompared).toBeGreaterThan(100);
    expect(elementsCompared).toBeGreaterThan(400);
    expect(programsInspected).toBeGreaterThan(100);
  },
  // Rule 12: ~400 tool calls. Fast here, and this budget is sized for a
  // loaded two-core CI box rather than for the local stopwatch.
  { timeout: 60_000 },
);

test("a hostile notification value travels as argv after --, verbatim", async () => {
  _setPlatform("darwin");
  const value = '" & (do shell script "id") & "';
  await desktopNotify.execute({ title: value, body: "b" } as never);
  const argv = argvSeen[0]?.argv ?? [];
  const cut = argv.indexOf("--");
  console.log(`OSASCRIPT ${JSON.stringify(argv)}`);
  // The separator exists, the value is AFTER it, and it arrived unchanged —
  // this package does not escape the value, it moves it out of the program.
  expect(cut).toBeGreaterThan(0);
  expect(argv.slice(cut + 1)).toEqual([value, "b"]);
  expect(osascriptProgramText(argv)).not.toContain("do shell script");
  // The compiled statements read their values positionally, which is the
  // whole mechanism.
  expect(osascriptProgramText(argv)).toContain("item 1 of argv");
});

test("notify-send puts every caller value after -- and every option in =form", async () => {
  _setPlatform("linux");
  _setSessionEnv(X11);
  await desktopNotify.execute({ title: "-u", body: "-e", urgency: "critical" } as never);
  const argv = argvSeen[0]?.argv ?? [];
  const cut = argv.indexOf("--");
  console.log(`NOTIFY_SEND ${JSON.stringify(argv)}`);
  expect(argv[0]).toBe("notify-send");
  expect(cut).toBeGreaterThan(0);
  // Recorded failure this prevents: without `--`, notify-send answered
  // "Unknown urgency body specified" because `-u` became the urgency flag.
  expect(argv.slice(cut + 1)).toEqual(["-u", "-e"]);
  for (const option of optionPositions(argv).slice(1)) {
    expect(option).toMatch(/^--[a-z-]+=/);
  }
  // The D-Bus address is forwarded, or the daemon is never reached.
  expect(Object.keys(argvSeen[0]?.env ?? {})).toContain("DBUS_SESSION_BUS_ADDRESS");
});

test("a Windows toast carries its payload in the environment, never in argv", async () => {
  _setPlatform("win32");
  const value = "</toast><toast><text>pwned</text></toast> & <script>";
  await desktopNotify.execute({ title: value, body: value } as never);
  const recorded = argvSeen[0];
  console.log(`TOAST_ARGV ${JSON.stringify(recorded?.argv)}`);
  console.log(`TOAST_ENV ${JSON.stringify(recorded?.env)}`);
  expect(recorded).toBeDefined();
  for (const element of recorded?.argv ?? []) {
    expect(element).not.toContain("pwned");
  }
  const xml = recorded?.env?.["CREWHAUS_TOAST_XML"] ?? "";
  // It reached the toast, escaped: one `<toast>` element, and the caller's
  // angle brackets and ampersand are entities rather than markup.
  expect(xml).toContain("&lt;/toast&gt;");
  expect(xml).toContain("&amp;");
  expect(xml.match(/<toast>/g)?.length).toBe(1);
});

test("every powershell argv is a registered script with nothing appended", async () => {
  _setPlatform("win32");
  const sources = registeredPowerShellSources();
  for (const call of [
    () => clipboardRead.execute({} as never),
    () => clipboardWrite.execute({ text: "x" } as never),
    () => desktopNotify.execute({ title: "t", body: "b" } as never),
    () => openExternal.execute({ target: "https://example.com/a?b=1&c=2" } as never),
    () => windowList.execute({} as never),
    () => userPresence.execute({} as never),
    () => powerAssertion.execute({ action: "hold" } as never),
  ]) {
    try {
      await call();
    } catch {
      /* refusals are fine; the argv SHAPE is what is under test */
    }
  }
  const shells = argvSeen.filter((r) => (r.argv[0] ?? "").toLowerCase() === "powershell.exe");
  console.log(`PS_CALLS=${shells.length}`);
  expect(shells.length).toBeGreaterThan(0);
  for (const { argv } of shells) {
    // Exactly: powershell.exe + the fixed flags + ONE registered script.
    expect(argv.length).toBe(1 + POWERSHELL_FLAGS.length + 1);
    expect(argv.slice(1, 1 + POWERSHELL_FLAGS.length)).toEqual([...POWERSHELL_FLAGS]);
    // `powershell -Command <script> a b` concatenates `a b` onto the command
    // string, so anything after the script would be source again.
    expect(sources.has(argv[argv.length - 1] as string)).toBe(true);
  }
});

test("a clipboard payload is piped on stdin and never appears in argv", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    argvSeen = [];
    const secret = "correct horse battery staple -rf $(id)";
    await clipboardWrite.execute({ text: secret } as never);
    const recorded = argvSeen[0];
    console.log(`WRITE_${platform} ${JSON.stringify(recorded?.argv)}`);
    expect(recorded?.stdin).toBe(secret);
    for (const element of recorded?.argv ?? []) expect(element).not.toContain("battery");
  }
});

// ---------------------------------------------------------------------------
// privilege
// ---------------------------------------------------------------------------

test("no argv ever names an escalation program", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    for (const call of [
      () => clipboardRead.execute({} as never),
      () => clipboardWrite.execute({ text: "x" } as never),
      () => desktopNotify.execute({ title: "t", body: "b" } as never),
      () => openExternal.execute({ target: "https://example.com" } as never),
      () => printDocument.execute({ path: "package.json" } as never),
      () => windowList.execute({} as never),
      () => userPresence.execute({} as never),
      () => powerAssertion.execute({ action: "hold" } as never),
    ]) {
      try {
        await call();
      } catch {
        /* platform refusals are fine */
      }
    }
  }
  const all = [...argvSeen, ...detachSeen];
  const bad = all.filter(({ argv }) =>
    argv.some((a) => /(^|[\\/])(sudo|doas|runas|pkexec|gksudo|su)(\.exe)?$/i.test(a)),
  );
  console.log(`RAN=${all.length} ESCALATIONS=${bad.length}`);
  expect(all.length).toBeGreaterThan(0);
  expect(bad).toEqual([]);
});

test("no schema accepts a password or an escalation flag", () => {
  for (const tool of [
    clipboardRead,
    clipboardWrite,
    desktopNotify,
    openExternal,
    printDocument,
    windowList,
    userPresence,
    powerAssertion,
  ]) {
    const shape = JSON.stringify(tool.inputSchema);
    for (const field of [
      "password",
      "sudo",
      "become",
      "runAs",
      "elevate",
      "privileged",
      "secret",
    ]) {
      expect({ tool: tool.name, field, present: shape.includes(field) }).toEqual({
        tool: tool.name,
        field,
        present: false,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// the contract flags
// ---------------------------------------------------------------------------

test("ClipboardRead declares the flags its output risk calls for", () => {
  // Not defaults: decisions. The clipboard is attacker-influenceable content
  // entering the model's context, so the injection classifier must run on it;
  // and the RISK is the output rather than the effect, which is exactly what
  // the justification gate is for.
  console.log(
    `CLIPBOARD_FLAGS classify=${clipboardRead.classifyOutput} justify=${clipboardRead.requireJustification} readOnly=${clipboardRead.readOnly}`,
  );
  expect(clipboardRead.classifyOutput).toBe(true);
  expect(clipboardRead.requireJustification).toBe(true);
  expect(clipboardRead.readOnly).toBe(true);
  // And it says so out loud, so a caller is not surprised by what it returns.
  expect(clipboardRead.description).toMatch(/password|secret|sensitive/i);
  expect(clipboardRead.description).toMatch(/does NOT scan|not.{0,20}redact/i);
  // The one thing the task forbade: a redaction heuristic. No schema knob for
  // it, because offering one implies the tool could do it.
  expect(JSON.stringify(clipboardRead.inputSchema)).not.toMatch(/redact/i);
});

test("every state-changing tool declares itself and every read-only one is marked", () => {
  const all = [
    clipboardRead,
    clipboardWrite,
    desktopNotify,
    openExternal,
    printDocument,
    windowList,
    userPresence,
    powerAssertion,
  ];
  console.log(
    all
      .map((t) => `${t.name} readOnly=${t.readOnly} destructive=${t.destructive} scope=${t.scope}`)
      .join("\n"),
  );
  expect(clipboardWrite.destructive).toBe(true);
  expect(printDocument.destructive).toBe(true);
  expect(powerAssertion.destructive).toBe(true);
  expect(windowList.readOnly).toBe(true);
  expect(userPresence.readOnly).toBe(true);
  // Every tool here spawns a process, so every one must lower external or the
  // `compile --strict` scope audit fails the build.
  for (const tool of all) {
    expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
      name: tool.name,
      scope: "external",
      io: "process",
    });
  }
});

// ---------------------------------------------------------------------------
// failing closed
// ---------------------------------------------------------------------------

test("every tool fails closed on a platform with no backend", async () => {
  _setPlatform("unsupported");
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["ClipboardRead", () => clipboardRead.execute({} as never)],
    ["ClipboardWrite", () => clipboardWrite.execute({ text: "x" } as never)],
    ["DesktopNotify", () => desktopNotify.execute({ title: "t", body: "b" } as never)],
    ["OpenExternal", () => openExternal.execute({ target: "https://example.com" } as never)],
    ["PrintDocument", () => printDocument.execute({ path: "package.json" } as never)],
    ["WindowList", () => windowList.execute({} as never)],
    ["UserPresence", () => userPresence.execute({} as never)],
    ["PowerAssertion", () => powerAssertion.execute({ action: "hold" } as never)],
  ];
  for (const [name, call] of calls) {
    const out = JSON.parse(String(await call())) as Record<string, unknown>;
    console.log(`UNSUPPORTED ${name} ${JSON.stringify(out).slice(0, 180)}`);
    // A typed answer, never a throw and never a bare false.
    expect(out["tool"]).toBe(name);
    expect(out["platform"]).toBe("unsupported");
    if (name === "UserPresence") {
      // Presence answers with nulls plus named unknowns rather than an
      // `unavailable`, because "which fields could not be read" IS the answer.
      expect(out["idleSeconds"]).toBeNull();
      expect(out["idle"]).toBeNull();
      expect(out["screenLocked"]).toBeNull();
      expect(Array.isArray(out["unknown"])).toBe(true);
    } else {
      expect(out["outcome"]).toBe("unavailable");
      expect(String(out["reason"])).toMatch(/unsupported|no .* backend/i);
    }
  }
});

test("a headless Linux session is a missing session, not an empty desktop", async () => {
  _setPlatform("linux");
  _setSessionEnv(HEADLESS_ENV);
  for (const [name, call] of [
    ["ClipboardRead", () => clipboardRead.execute({} as never)],
    ["DesktopNotify", () => desktopNotify.execute({ title: "t", body: "b" } as never)],
    ["WindowList", () => windowList.execute({} as never)],
  ] as Array<[string, () => Promise<unknown>]>) {
    const out = JSON.parse(String(await call())) as Record<string, unknown>;
    console.log(`HEADLESS ${name} ${JSON.stringify(out).slice(0, 200)}`);
    expect(out["outcome"]).toBe("unavailable");
    expect(out["missing"]).toBe("session");
    expect(String(out["reason"])).toMatch(/DISPLAY|WAYLAND_DISPLAY/);
  }
  // Nothing was spawned: there was nothing to ask.
  expect(argvSeen).toEqual([]);
});

// ---------------------------------------------------------------------------
// "could not determine" is not "no"
// ---------------------------------------------------------------------------

test("an empty clipboard, a non-text one and an unreadable one are three answers", async () => {
  _setPlatform("darwin");
  const seen: Record<string, Record<string, unknown>> = {};

  answers["pbpaste"] = { code: 0, stdout: "" };
  answers["osascript"] = { code: 0, stdout: "" };
  seen["empty"] = JSON.parse(String(await clipboardRead.execute({} as never)));

  answers["osascript"] = { code: 0, stdout: "PNGf, 284913, TIFF picture, 1063968" };
  seen["image"] = JSON.parse(String(await clipboardRead.execute({} as never)));

  answers["pbpaste"] = { code: 1, stdout: "", timedOut: true };
  seen["timeout"] = JSON.parse(String(await clipboardRead.execute({} as never)));

  answers["pbpaste"] = { code: 0, stdout: "hunter2" };
  seen["read"] = JSON.parse(String(await clipboardRead.execute({} as never)));

  console.log(`CLIPBOARD ${JSON.stringify(seen)}`);
  expect(seen["empty"]?.["outcome"]).toBe("empty");
  expect(seen["image"]?.["outcome"]).toBe("noTextFlavour");
  expect(seen["read"]?.["outcome"]).toBe("read");
  // The timed-out read is UNAVAILABLE, and its reason says what is unknown —
  // an assertion that only checked "not read" would also pass on a crash.
  expect(seen["timeout"]?.["outcome"]).toBe("unavailable");
  expect(String(seen["timeout"]?.["reason"])).toMatch(/not the same as it being empty/i);
});

test("a window list that could not be read is never an empty list", async () => {
  _setPlatform("darwin");
  // Accessibility not granted. RECORDED stderr, and its code is what makes
  // this a grant problem rather than a broken script.
  answers["osascript"] = {
    code: 1,
    stderr:
      "44:87: execution error: System Events got an error: osascript is not allowed assistive access. (-25211)",
  };
  const denied = JSON.parse(String(await windowList.execute({} as never))) as Record<
    string,
    unknown
  >;
  console.log(`WINDOWS_DENIED ${JSON.stringify(denied)}`);
  expect(denied["outcome"]).toBe("unavailable");
  expect(denied["missing"]).toBe("permission");
  expect(String(denied["reason"])).toMatch(/Accessibility/);
  expect(denied["windows"]).toBeUndefined();

  answers["osascript"] = { code: -1, timedOut: true };
  const timedOut = JSON.parse(String(await windowList.execute({} as never))) as Record<
    string,
    unknown
  >;
  console.log(`WINDOWS_TIMEOUT ${JSON.stringify(timedOut)}`);
  expect(timedOut["outcome"]).toBe("unavailable");
  expect(String(timedOut["reason"])).toMatch(/not the same as there being no windows/i);

  // A Wayland session: not a missing program, and nothing to install.
  _setPlatform("linux");
  _setSessionEnv({
    ...HEADLESS_ENV,
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  const wayland = JSON.parse(String(await windowList.execute({} as never))) as Record<
    string,
    unknown
  >;
  console.log(`WINDOWS_WAYLAND ${JSON.stringify(wayland)}`);
  expect(wayland["outcome"]).toBe("unavailable");
  expect(String(wayland["reason"])).toMatch(/Wayland/);
});

test("a truncated window list is reported as a prefix, not as the whole desktop", async () => {
  _setPlatform("linux");
  _setSessionEnv(X11);
  answers["wmctrl"] = {
    code: 0,
    stdout: "0x01 0 100 0 0 10 10 a.A host One\n",
    stdoutTruncated: true,
  };
  const out = JSON.parse(String(await windowList.execute({} as never))) as Record<string, unknown>;
  console.log(`WINDOWS_TRUNCATED ${JSON.stringify(out)}`);
  expect(out["outcome"]).toBe("listed");
  expect(out["truncated"]).toBe(true);
  expect(JSON.stringify(out["unknown"])).toMatch(/PREFIX/);
});

test("a presence probe that failed is not the user being idle", async () => {
  _setPlatform("darwin");
  answers["ioreg"] = { code: 127, missing: true };
  const out = JSON.parse(String(await userPresence.execute({} as never))) as Record<
    string,
    unknown
  >;
  console.log(`PRESENCE_MISSING ${JSON.stringify(out)}`);
  expect(out["idleSeconds"]).toBeNull();
  expect(out["idle"]).toBeNull();
  expect(out["screenLocked"]).toBeNull();
  const unknown = JSON.stringify(out["unknown"]);
  // The REASON, not merely the absence: "not installed" and "timed out" are
  // different instructions to a caller and must not collapse into one.
  expect(unknown).toMatch(/not installed/);
  expect(unknown).toMatch(/ioreg/);
});

test("an ssh session does not claim to know whether a person is at the machine", async () => {
  _setPlatform("linux");
  _setSessionEnv({ ...X11, SSH_CONNECTION: "10.0.0.2 51234 10.0.0.9 22" });
  answers["xprintidle"] = { code: 0, stdout: "900000\n" };
  answers["loginctl"] = { code: 0, stdout: "LockedHint=no\nType=x11\nActive=yes\n" };
  const out = JSON.parse(String(await userPresence.execute({} as never))) as Record<
    string,
    unknown
  >;
  console.log(`PRESENCE_SSH ${JSON.stringify(out)}`);
  expect(out["sessionKind"]).toBe("ssh");
  expect(out["idleSeconds"]).toBe(900);
  expect(JSON.stringify(out["unknown"])).toMatch(/far end/);
});

test("a printer query that timed out is not a host with no printers", async () => {
  _setPlatform("darwin");
  answers["lpstat"] = { code: -1, timedOut: true };
  const out = JSON.parse(
    String(await printDocument.execute({ path: "package.json", dryRun: true } as never)),
  ) as Record<string, unknown>;
  const queue = out["queue"] as Record<string, unknown>;
  console.log(`PRINT_TIMEOUT ${JSON.stringify(out).slice(0, 300)}`);
  expect(queue["printers"]).toEqual([]);
  expect(String(queue["queueUnreadable"])).toMatch(/NOT that it has none/);

  answers["lpstat"] = { code: 1, stderr: "lpstat: Scheduler is not running." };
  const down = JSON.parse(
    String(await printDocument.execute({ path: "package.json" } as never)),
  ) as Record<string, unknown>;
  console.log(`PRINT_SCHEDULER ${JSON.stringify(down).slice(0, 300)}`);
  expect(down["outcome"]).toBe("unavailable");
  expect(String(down["reason"])).toMatch(/not the same as the host having no printers/i);
  // Nothing was sent to a queue that could not have taken it.
  expect(argvSeen.some((r) => r.argv[0] === "lp")).toBe(false);
});

// ---------------------------------------------------------------------------
// OpenExternal's allow-list
// ---------------------------------------------------------------------------

test("OpenExternal refuses every scheme outside the allow-list, by name", async () => {
  _setPlatform("darwin");
  const refused: string[] = [];
  for (const target of [
    "file:///etc/passwd",
    "smb://attacker.example/share",
    "nfs://host/export",
    "ms-settings:privacy",
    "shell:Startup",
    "search-ms:query=x",
    "javascript:alert(1)",
    "data:text/html,<script>x</script>",
    "vbscript:msgbox",
    "ftp://host/f",
    "vscode://file/etc/passwd",
    "chrome://settings",
  ]) {
    argvSeen = [];
    const out = JSON.parse(String(await openExternal.execute({ target } as never))) as Record<
      string,
      unknown
    >;
    refused.push(`${target} -> ${out["outcome"]}`);
    expect(out["outcome"]).toBe("refused");
    expect(String(out["reason"])).toContain(":");
    // Nothing reached the OS.
    expect(argvSeen).toEqual([]);
  }
  console.log(refused.join("\n"));
});

test("OpenExternal opens an allowed scheme, and allowSchemes can only narrow", async () => {
  _setPlatform("darwin");
  const ok = JSON.parse(
    String(await openExternal.execute({ target: "https://example.com/a?b=1&c=2" } as never)),
  ) as Record<string, unknown>;
  console.log(`OPEN_OK ${JSON.stringify(ok)} ${JSON.stringify(argvSeen[0]?.argv)}`);
  expect(ok["outcome"]).toBe("handedOff");
  // `--` before the target, verified on this macOS: `open -- -a` treats `-a`
  // as a filename rather than as an option.
  expect(argvSeen[0]?.argv).toEqual(["open", "--", "https://example.com/a?b=1&c=2"]);

  argvSeen = [];
  const narrowed = JSON.parse(
    String(
      await openExternal.execute({
        target: "http://example.com",
        allowSchemes: ["https"],
      } as never),
    ),
  ) as Record<string, unknown>;
  console.log(`OPEN_NARROWED ${JSON.stringify(narrowed)}`);
  expect(narrowed["outcome"]).toBe("refused");
  expect(argvSeen).toEqual([]);

  // There is no input that widens it: the enum rejects the value outright.
  const widened = openExternal.inputSchema.safeParse({
    target: "smb://host/share",
    allowSchemes: ["smb"],
  });
  expect(widened.success).toBe(false);
});

test("OpenExternal refuses an executable file and a path outside the workspace", async () => {
  _setPlatform("darwin");
  _setFs(memoryFs(() => ({ ...PLAIN_FILE, mode: 0o100755 })));
  const exe = JSON.parse(
    String(await openExternal.execute({ target: "package.json" } as never)),
  ) as Record<string, unknown>;
  console.log(`OPEN_EXEC ${JSON.stringify(exe)}`);
  expect(exe["outcome"]).toBe("refused");
  expect(String(exe["reason"])).toMatch(/executable/i);
  expect(argvSeen).toEqual([]);

  _setFs(memoryFs(() => PLAIN_FILE));
  const outside = JSON.parse(
    String(await openExternal.execute({ target: "../../../etc/passwd" } as never)),
  ) as Record<string, unknown>;
  console.log(`OPEN_OUTSIDE ${JSON.stringify(outside)}`);
  expect(outside["outcome"]).toBe("refused");
  expect(String(outside["reason"])).toMatch(/escapes the workspace root/);
  expect(argvSeen).toEqual([]);
});

test("xdg-open is never handed a flag-shaped target, because it has no --", async () => {
  _setPlatform("linux");
  _setSessionEnv(X11);
  const out = JSON.parse(String(await openExternal.execute({ target: "-rf" } as never))) as Record<
    string,
    unknown
  >;
  console.log(`OPEN_FLAG ${JSON.stringify(out)}`);
  expect(out["outcome"]).toBe("refused");
  expect(argvSeen).toEqual([]);

  argvSeen = [];
  await openExternal.execute({ target: "https://example.com" } as never);
  // Two elements only: no `--`, because xdg-open would read it as an option.
  // The URL is the NORMALISED one (note the trailing slash) — see
  // `classifyTarget`: the string that passed the gate is the string that is
  // handed over, so the two cannot come apart.
  expect(argvSeen[0]?.argv).toEqual(["xdg-open", "https://example.com/"]);
});

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

test("lp is never handed a destination or a range that could be an option", async () => {
  _setPlatform("darwin");
  answers["lpstat"] = { code: 0, stdout: LPSTAT_STDOUT };
  for (const bad of [
    { printer: "-d" },
    { printer: "-o raw" },
    { printer: "a/b" },
    { pageRanges: "1;id" },
    { pageRanges: "-1" },
    { pageRanges: "$(id)" },
  ]) {
    argvSeen = [];
    const out = JSON.parse(
      String(await printDocument.execute({ path: "package.json", ...bad } as never)),
    ) as Record<string, unknown>;
    console.log(`PRINT_REFUSED ${JSON.stringify(bad)} -> ${String(out["reason"]).slice(0, 90)}`);
    expect(out["outcome"]).toBe("refused");
    // Refused BEFORE the queue was even probed — nothing ran at all.
    expect(argvSeen).toEqual([]);
  }
});

test("a real print probes the queue first and passes options as separate argv elements", async () => {
  _setPlatform("darwin");
  answers["lpstat"] = { code: 0, stdout: LPSTAT_STDOUT };
  answers["lp"] = { code: 0, stdout: "request id is Canon_MX490_series-34 (1 file(s))\n" };
  const out = JSON.parse(
    String(
      await printDocument.execute({
        path: "package.json",
        printer: "Canon_MX490_series",
        copies: 2,
        pageRanges: "1-4",
        duplex: "two-sided-long-edge",
      } as never),
    ),
  ) as Record<string, unknown>;
  console.log(`PRINT_ARGV ${JSON.stringify(argvSeen.map((r) => r.argv))}`);
  console.log(`PRINT_OUT ${JSON.stringify(out).slice(0, 300)}`);
  expect(argvSeen[0]?.argv).toEqual(["lpstat", "-p", "-d"]);
  const lp = argvSeen[1]?.argv ?? [];
  expect(lp.slice(0, 9)).toEqual([
    "lp",
    "-d",
    "Canon_MX490_series",
    "-n",
    "2",
    "-o",
    "page-ranges=1-4",
    "-o",
    "sides=two-sided-long-edge",
  ]);
  // The document is the LAST element and is absolute, so it can never be read
  // as an option by a program that has no `--`.
  expect(lp[9]).toMatch(/^\/.*package\.json$/);
  expect(lp.length).toBe(10);
  expect(out["outcome"]).toBe("queued");
  expect(out["jobId"]).toBe("Canon_MX490_series-34");
});

test("Windows printing names its gap instead of spooling something wrong", async () => {
  _setPlatform("win32");
  const pdf = JSON.parse(
    String(await printDocument.execute({ path: "package.json" } as never)),
  ) as Record<string, unknown>;
  console.log(`PRINT_WIN_PDF ${JSON.stringify(pdf)}`);
  expect(pdf["outcome"]).toBe("refused");
  expect(String(pdf["reason"])).toMatch(/rasterise|TEXT/i);
  expect(argvSeen).toEqual([]);
});

// ---------------------------------------------------------------------------
// dryRun == the real path
// ---------------------------------------------------------------------------

test("every dryRun resolves through the same code the real call uses", async () => {
  _setPlatform("darwin");
  answers["lpstat"] = { code: 0, stdout: LPSTAT_STDOUT };
  answers["lp"] = { code: 0, stdout: "request id is X-1 (1 file(s))\n" };

  const cases: Array<[string, Record<string, unknown>]> = [
    ["ClipboardWrite", { text: "hello" }],
    ["DesktopNotify", { title: "t", body: "b" }],
    ["OpenExternal", { target: "https://example.com" }],
    ["PrintDocument", { path: "package.json", printer: "Canon_MX490_series" }],
  ];
  const tools: Record<string, (i: unknown) => Promise<unknown>> = {
    ClipboardWrite: (i) => clipboardWrite.execute(i),
    DesktopNotify: (i) => desktopNotify.execute(i),
    OpenExternal: (i) => openExternal.execute(i),
    PrintDocument: (i) => printDocument.execute(i),
  };

  for (const [name, input] of cases) {
    argvSeen = [];
    const dryOut = JSON.parse(String(await tools[name]?.({ ...input, dryRun: true }))) as Record<
      string,
      unknown
    >;
    const dryRan = argvSeen.map((r) => r.argv.join(" "));
    const dryPlan = JSON.stringify((dryOut["plan"] as Record<string, unknown>)?.["argv"]);

    argvSeen = [];
    await tools[name]?.(input);
    const realRan = argvSeen.map((r) => r.argv.join(" "));

    console.log(`DRY  ${name} ${JSON.stringify(dryRan)} plan=${dryPlan}`);
    console.log(`REAL ${name} ${JSON.stringify(realRan)}`);
    expect(dryOut["outcome"]).toBe("dryRun");
    // The real run does everything the dry run did, in order, and then more.
    expect(realRan.slice(0, dryRan.length)).toEqual(dryRan);
    expect(realRan.length).toBeGreaterThan(dryRan.length);
    // And the command the dry run PREDICTED is the one that then ran — the
    // drift tool-hostfs's TrashPath preview shipped once.
    expect(dryPlan).toBe(JSON.stringify(argvSeen[argvSeen.length - 1]?.argv));
  }
});

// ---------------------------------------------------------------------------
// PowerAssertion
// ---------------------------------------------------------------------------

test("a hold is always bounded, and the deadline is the holder's own argument", async () => {
  _setPlatform("darwin");
  const out = JSON.parse(
    String(await powerAssertion.execute({ action: "hold", maxMinutes: 45 } as never)),
  ) as Record<string, unknown>;
  console.log(`HOLD ${JSON.stringify(out)} detach=${JSON.stringify(detachSeen[0]?.argv)}`);
  expect(out["outcome"]).toBe("held");
  // `-t 2700` is what makes the bound survive this harness being killed.
  expect(detachSeen[0]?.argv).toEqual(["caffeinate", "-i", "-m", "-t", "2700"]);
  expect(out["expiresAt"]).toBe(new Date(1_700_000_000_000 + 2_700_000).toISOString());

  // Above the ceiling: refused with the ceiling named, and nothing started.
  detachSeen = [];
  files.clear();
  const tooLong = JSON.parse(
    String(await powerAssertion.execute({ action: "hold", maxMinutes: 10_000 } as never)),
  ) as Record<string, unknown>;
  console.log(`HOLD_LONG ${JSON.stringify(tooLong)}`);
  expect(tooLong["outcome"]).toBe("refused");
  expect(detachSeen).toEqual([]);
  // The schema refuses it too, before execute is even reached.
  expect(powerAssertion.inputSchema.safeParse({ action: "hold", maxMinutes: 10_000 }).success).toBe(
    false,
  );
});

test("every platform's holder carries its own deadline", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    _setPlatform(platform);
    detachSeen = [];
    files.clear();
    await powerAssertion.execute({ action: "hold" } as never);
    const argv = detachSeen[0]?.argv ?? [];
    console.log(`HOLD_${platform} ${JSON.stringify(argv)}`);
    if (platform === "win32") {
      // The flag and the seconds travel in the environment; the script is a
      // registered constant. The thing that must NOT happen on Windows is a
      // one-liner that sets the flag and exits — the script parks instead.
      expect(argv[argv.length - 1]).toContain("Start-Sleep");
      expect(argv.join(" ")).toContain("SetThreadExecutionState");
    } else {
      expect(argv.join(" ")).toContain("1800");
    }
  }
});

test("release verifies the pid is still ours before signalling anything", async () => {
  _setPlatform("darwin");
  await powerAssertion.execute({ action: "hold" } as never);

  // (a) the recorded pid is still running our holder -> SIGTERM it.
  argvSeen = [];
  answers["ps"] = { code: 0, stdout: PS_CAFFEINATE_STDOUT };
  const released = JSON.parse(
    String(await powerAssertion.execute({ action: "release" } as never)),
  ) as Record<string, unknown>;
  console.log(
    `RELEASE_OK ${JSON.stringify(released)} ran=${JSON.stringify(argvSeen.map((r) => r.argv))}`,
  );
  expect(released["outcome"]).toBe("released");
  expect(argvSeen.map((r) => r.argv)).toEqual([
    ["ps", "-o", "command=", "-p", "4242"],
    ["kill", "-TERM", "4242"],
  ]);

  // (b) the pid was REUSED by something else -> clear the file, kill nothing.
  files.clear();
  await powerAssertion.execute({ action: "hold" } as never);
  argvSeen = [];
  answers["ps"] = { code: 0, stdout: PS_REUSED_PID_STDOUT };
  const stale = JSON.parse(
    String(await powerAssertion.execute({ action: "release" } as never)),
  ) as Record<string, unknown>;
  console.log(
    `RELEASE_REUSED ${JSON.stringify(stale)} ran=${JSON.stringify(argvSeen.map((r) => r.argv))}`,
  );
  expect(stale["outcome"]).toBe("stale");
  expect(argvSeen.some((r) => r.argv[0] === "kill")).toBe(false);

  // (c) the probe could not answer -> signal nothing AND keep the record, so
  // the assertion can still be released before its deadline.
  files.clear();
  await powerAssertion.execute({ action: "hold" } as never);
  argvSeen = [];
  answers["ps"] = { code: -1, timedOut: true };
  const unknown = JSON.parse(
    String(await powerAssertion.execute({ action: "release" } as never)),
  ) as Record<string, unknown>;
  console.log(`RELEASE_UNKNOWN ${JSON.stringify(unknown)}`);
  expect(unknown["outcome"]).toBe("unknown");
  expect(argvSeen.some((r) => r.argv[0] === "kill")).toBe(false);
  expect(files.size).toBe(1);
});

test("status reports when the assertion expires, off the injected clock", async () => {
  _setPlatform("darwin");
  await powerAssertion.execute({ action: "hold", maxMinutes: 10 } as never);
  answers["ps"] = { code: 0, stdout: PS_CAFFEINATE_STDOUT };

  const held = JSON.parse(
    String(await powerAssertion.execute({ action: "status" } as never)),
  ) as Record<string, unknown>;
  console.log(`STATUS_HELD ${JSON.stringify(held)}`);
  expect(held["outcome"]).toBe("held");
  expect(held["expiresInMs"]).toBe(600_000);

  // Move the clock past the deadline. Nothing is measured with a stopwatch —
  // the clock is a seam, so this assertion is exact on any machine.
  _setClock(() => 1_700_000_000_000 + 700_000);
  const expiring = JSON.parse(
    String(await powerAssertion.execute({ action: "status" } as never)),
  ) as Record<string, unknown>;
  console.log(`STATUS_EXPIRING ${JSON.stringify(expiring)}`);
  expect(expiring["outcome"]).toBe("expiring");
  expect(expiring["expiresInMs"]).toBe(-100_000);
});

test("a second hold does not stack on top of a live one", async () => {
  _setPlatform("darwin");
  await powerAssertion.execute({ action: "hold" } as never);
  answers["ps"] = { code: 0, stdout: PS_CAFFEINATE_STDOUT };
  detachSeen = [];
  const again = JSON.parse(
    String(await powerAssertion.execute({ action: "hold" } as never)),
  ) as Record<string, unknown>;
  console.log(`HOLD_AGAIN ${JSON.stringify(again)}`);
  expect(again["outcome"]).toBe("alreadyHeld");
  expect(detachSeen).toEqual([]);
});

test("a Linux reason reaches systemd-inhibit as one --why= element, or is refused", async () => {
  _setPlatform("linux");
  detachSeen = [];
  await powerAssertion.execute({ action: "hold", reason: "compiling the release" } as never);
  const argv = detachSeen[0]?.argv ?? [];
  console.log(`INHIBIT ${JSON.stringify(argv)}`);
  expect(argv[0]).toBe("systemd-inhibit");
  expect(argv).toContain("--why=compiling the release");
  // `sleep` is a program, not a shell: the argv array is never re-parsed.
  expect(argv[argv.length - 2]).toBe("sleep");

  files.clear();
  detachSeen = [];
  const bad = JSON.parse(
    String(await powerAssertion.execute({ action: "hold", reason: "a\nb" } as never)),
  ) as Record<string, unknown>;
  console.log(`INHIBIT_BAD ${JSON.stringify(bad)}`);
  expect(bad["outcome"]).toBe("refused");
  expect(detachSeen).toEqual([]);
});

// ---------------------------------------------------------------------------
// the refusals the review of this package added
// ---------------------------------------------------------------------------

test("OpenExternal refuses what a desktop would RUN, mode bit or no mode bit", async () => {
  _setPlatform("win32");
  // A `.bat` with NO execute bit. Windows has no execute bit worth reading —
  // `statSync` there reports a runnable batch file as mode 0o100666 — so a
  // mode-only check passes it straight to Start-Process.
  for (const name of ["deploy.bat", "run.cmd", "setup.ps1", "install.exe", "macro.vbs"]) {
    argvSeen = [];
    const out = JSON.parse(String(await openExternal.execute({ target: name } as never))) as Record<
      string,
      unknown
    >;
    console.log(`OPEN_RUNNABLE ${name} -> ${String(out["reason"]).slice(0, 70)}`);
    expect(out["outcome"]).toBe("refused");
    expect(argvSeen).toEqual([]);
  }

  // A macOS `.app` is a DIRECTORY, so `isFile` is false and the mode check
  // never even applies — while `open Foo.app` launches it.
  _setPlatform("darwin");
  _setFs(memoryFs(() => ({ ...PLAIN_FILE, isFile: false, isDirectory: true, mode: 0o40755 })));
  argvSeen = [];
  const bundle = JSON.parse(
    String(await openExternal.execute({ target: "Calculator.app" } as never)),
  ) as Record<string, unknown>;
  console.log(`OPEN_BUNDLE ${JSON.stringify(bundle)}`);
  expect(bundle["outcome"]).toBe("refused");
  expect(argvSeen).toEqual([]);

  // Indirection: a `.url` or `.desktop` file holds a target that never passed
  // the scheme allow-list, so opening one walks straight around the gate.
  _setFs(memoryFs(() => PLAIN_FILE));
  for (const name of ["bookmark.url", "shortcut.lnk", "launcher.desktop", "note.webloc"]) {
    argvSeen = [];
    const out = JSON.parse(String(await openExternal.execute({ target: name } as never))) as Record<
      string,
      unknown
    >;
    console.log(`OPEN_INDIRECT ${name} -> ${out["outcome"]}`);
    expect(out["outcome"]).toBe("refused");
    expect(argvSeen).toEqual([]);
  }

  // ...and an ordinary document still opens.
  argvSeen = [];
  const doc = JSON.parse(
    String(await openExternal.execute({ target: "report.pdf" } as never)),
  ) as Record<string, unknown>;
  console.log(`OPEN_DOC ${JSON.stringify(doc)}`);
  expect(doc["outcome"]).toBe("handedOff");
  expect(argvSeen[0]?.argv?.[0]).toBe("open");
});

test("the Windows print path that DOES work carries its values in the environment", async () => {
  _setPlatform("win32");
  const out = JSON.parse(
    String(await printDocument.execute({ path: "notes.txt", printer: "Front_Desk" } as never)),
  ) as Record<string, unknown>;
  const print = argvSeen[argvSeen.length - 1];
  console.log(`PRINT_WIN_TXT ${JSON.stringify(out).slice(0, 200)}`);
  console.log(`PRINT_WIN_ARGV ${JSON.stringify(print?.argv)} env=${JSON.stringify(print?.env)}`);
  expect(out["outcome"]).toBe("queued");
  // The queue probe ran first here too, so the dry run stays a prefix.
  expect((argvSeen[0]?.argv ?? []).join(" ")).toContain("Get-Printer");
  // Neither the path nor the destination is in the argv: both cross in the
  // environment, because `-Command <script> a b` would concatenate them onto
  // the command string and make them source again.
  for (const element of print?.argv ?? []) {
    expect(element).not.toContain("Front_Desk");
    expect(element).not.toContain("notes.txt");
  }
  expect(print?.env?.["CREWHAUS_PRINT_DEST"]).toBe("Front_Desk");
  expect(String(print?.env?.["CREWHAUS_PRINT_PATH"])).toMatch(/notes\.txt$/);
});

test("a hold refuses when it cannot tell whether the last holder is still running", async () => {
  _setPlatform("darwin");
  await powerAssertion.execute({ action: "hold", maxMinutes: 60 } as never);

  // The probe cannot answer. Overwriting the state file here would leave the
  // first holder — possibly still running — with nothing able to release it.
  answers["ps"] = { code: -1, timedOut: true };
  detachSeen = [];
  const refused = JSON.parse(
    String(await powerAssertion.execute({ action: "hold" } as never)),
  ) as Record<string, unknown>;
  console.log(`HOLD_UNKNOWN ${JSON.stringify(refused)}`);
  expect(refused["outcome"]).toBe("refused");
  expect(String(refused["reason"])).toMatch(/could not say whether/);
  expect(detachSeen).toEqual([]);
  expect(files.size).toBe(1);

  // Once the RECORDED deadline has passed, the old holder has ended by its
  // own argument, so replacing it is safe and needs no probe at all.
  _setClock(() => 1_700_000_000_000 + 60 * 60_000 + 1);
  const fresh = JSON.parse(
    String(await powerAssertion.execute({ action: "hold" } as never)),
  ) as Record<string, unknown>;
  console.log(`HOLD_AFTER_EXPIRY ${JSON.stringify(fresh)}`);
  expect(fresh["outcome"]).toBe("held");
  expect(detachSeen.length).toBe(1);
});
