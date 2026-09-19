/**
 * The adversarial pass: one test per defect this review found, each written
 * so that it FAILS against the code as it was before the fix beside it.
 *
 * The ordering principle is the same as `index.test.ts`'s — assert on the
 * RECORDED ARGV and on the RECORDED ENVIRONMENT, never on the source — with
 * one addition that the findings below made necessary: assert on what the
 * OPERATING SYSTEM would be handed, which is not always the string the caller
 * sent. `OpenExternal` used to validate one spelling of a URL and pass on
 * another, and no argv assertion catches that unless it names the exact
 * element expected.
 *
 * Every test here states, in its comment, what the behaviour was before the
 * fix. That is what makes it a regression test rather than a description.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  HEADLESS_ENV,
  type SessionEnv,
  _resetHostSeams,
  _setClock,
  _setPlatform,
  _setSessionEnv,
  hostPlatform,
  sessionEnv,
} from "./host";
import {
  clipboardWrite,
  desktopNotify,
  openExternal,
  powerAssertion,
  printDocument,
} from "./index";
import { escapeXmlText } from "./lib/escape";
import { type HostFs, type PathFacts, _setFs } from "./lib/fsseam";
import { classifyLiveness, commandMatchesMarker } from "./lib/power";
import {
  type RunRequest,
  type RunResult,
  _allowRealHost,
  _resetRunSeams,
  _setDetacher,
  _setRunner,
  assertArgv,
  classifySpawnError,
} from "./run";

type Recorded = { argv: readonly string[]; env?: Readonly<Record<string, string>>; stdin?: string };

let argvSeen: Recorded[] = [];
let detachSeen: Recorded[] = [];
let answers: Record<string, Partial<RunResult>> = {};
let files: Map<string, string>;

const OK: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false, missing: false };

const PLAIN_FILE: PathFacts = {
  exists: true,
  isDirectory: false,
  isFile: true,
  mode: 0o100644,
  sizeBytes: 12,
};

function memoryFs(): HostFs {
  return {
    stat: () => PLAIN_FILE,
    readText: (p) => files.get(p),
    writeTextAtomic: (p, text) => {
      files.set(p, text);
    },
    remove: (p) => {
      files.delete(p);
    },
  };
}

beforeEach(() => {
  argvSeen = [];
  detachSeen = [];
  answers = {};
  files = new Map();
  _setPlatform("darwin");
  _setSessionEnv(HEADLESS_ENV);
  _setClock(() => 1_700_000_000_000);
  _setFs(memoryFs());
  _setRunner(async (request: RunRequest) => {
    argvSeen.push({
      argv: request.argv,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    });
    return { ...OK, ...(answers[request.argv[0] ?? ""] ?? {}) };
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

/** Written this way, never as a literal: house rule 13 and the source scan. */
const NUL = String.fromCharCode(0);

type Json = Record<string, unknown>;
const parse = (out: unknown): Json => JSON.parse(String(out)) as Json;

/** Every string this call handed a child: argv elements, env values, stdin. */
function everythingSent(): string[] {
  const out: string[] = [];
  for (const call of [...argvSeen, ...detachSeen]) {
    out.push(...call.argv);
    for (const value of Object.values(call.env ?? {})) out.push(value);
    if (call.stdin !== undefined) out.push(call.stdin);
  }
  return out;
}

const STATE_FILE = `${process.cwd()}/.crewhaus/power-assertion.json`;

// ---------------------------------------------------------------------------
// OpenExternal — the scheme gate is a parse, and the parse must be the thing
// that travels
// ---------------------------------------------------------------------------

test("the URL that passed the gate is the URL that is opened, on every platform", async () => {
  // BEFORE THE FIX: `classifyTarget` validated `new URL(trimmed)` and then
  // returned `trimmed` — the caller's raw text — for the opener to run. So
  // the host that was CHECKED and the host that would be OPENED were only
  // the same when the two parsers agreed, and the interesting inputs are
  // exactly the ones where they do not.
  const cases: ReadonlyArray<[string, string]> = [
    // WHATWG fills in the missing authority; CFURL and xdg-open do not.
    ["https:evil.example", "https://evil.example/"],
    ["HTTPS://EVIL.example", "https://evil.example/"],
    ["https://ok.example", "https://ok.example/"],
    ["  https://ok.example/a  ", "https://ok.example/a"],
  ];
  let checked = 0;
  for (const platform of ["darwin", "linux", "win32"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    for (const [given, normalized] of cases) {
      argvSeen = [];
      const out = parse(await openExternal.execute({ target: given } as never));
      expect(out["outcome"]).toBe("handedOff");
      const sent = everythingSent();
      // The normalised form went out...
      expect(sent).toContain(normalized);
      // ...and the caller's raw spelling did not, unless they happened to
      // be the same string.
      if (given.trim() !== normalized) expect(sent).not.toContain(given.trim());
      // A rewrite is REPORTED rather than silent, so a caller can see that
      // what opened is not byte-for-byte what they asked for.
      if (given.trim() !== normalized) {
        expect(out["url"]).toBe(normalized);
        expect(out["given"]).toBe(given.trim());
      }
      checked += 1;
    }
  }
  // The matrix ran; a `cases` list emptied by a bad edit cannot pass quietly.
  expect(checked).toBe(12);
});

test("a URL whose parsers would disagree about the host is refused, not folded", async () => {
  // BEFORE THE FIX: `new URL("https://example.com\\@evil.example/")` folds the
  // backslash to a slash, so WHATWG reports host `example.com` — and the tool
  // then handed the RAW text to `open`, where CFURL reads `example.com\` as
  // userinfo and `evil.example` as the host. The gate approved one site and
  // the desktop would have opened another.
  for (const platform of ["darwin", "linux", "win32"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    for (const target of ["https://example.com\\@evil.example/", "https://example.com\\..\\evil"]) {
      argvSeen = [];
      const out = parse(await openExternal.execute({ target } as never));
      expect(out["outcome"]).toBe("refused");
      expect(String(out["reason"])).toContain("backslash");
      // Nothing ran. A refusal that still spawned the opener would be no
      // refusal at all.
      expect(argvSeen).toEqual([]);
    }
  }
});

test("a URL carrying credentials before the @ is refused and never reaches an argv", async () => {
  // BEFORE THE FIX: accepted. `https://google.com@evil.example/x` was reported
  // as `scheme: https` with the raw target, which reads as google.com to a
  // human and to a model checking the result, while the browser goes to
  // evil.example; and `https://u:hunter2@h.example/` put the password into an
  // argv (world-readable through `ps`) and into this run's transcript.
  const secret = "hunter2";
  for (const platform of ["darwin", "linux", "win32"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    for (const target of [
      "https://google.com@evil.example/x",
      `https://u:${secret}@h.example/`,
      `http://u:${secret}@h.example/`,
    ]) {
      argvSeen = [];
      const out = parse(await openExternal.execute({ target } as never));
      expect(out["outcome"]).toBe("refused");
      expect(String(out["reason"])).toContain("credentials");
      expect(argvSeen).toEqual([]);
      // The refusal itself must not repeat the secret back into the result.
      expect(JSON.stringify(out)).not.toContain(secret);
    }
  }
});

test("a mailto: carries only the headers RFC 6068 calls safe", async () => {
  // BEFORE THE FIX: mailto: skipped parsing entirely — the code read
  // `if (scheme !== "mailto")` around the whole URL check — so
  // `mailto:x@y?attach=/etc/passwd` was handed straight to the desktop. A
  // mail client that honours `attach` reads a LOCAL FILE into a message
  // addressed to whoever the URI names, which is the hole `file:` is refused
  // for with a mail client standing in the middle.
  const refused = [
    "mailto:victim@example.com?attach=/etc/passwd",
    "mailto:victim@example.com?attachment=/etc/shadow",
    "mailto:victim@example.com?ATTACH=/etc/passwd",
    "mailto:victim@example.com?x-forward=1",
  ];
  for (const target of refused) {
    argvSeen = [];
    const out = parse(await openExternal.execute({ target } as never));
    expect(out["outcome"]).toBe("refused");
    expect(argvSeen).toEqual([]);
  }
  // The named one says WHY, in the caller's terms, rather than just "no".
  const attach = parse(await openExternal.execute({ target: refused[0] as string } as never));
  expect(String(attach["reason"])).toContain("LOCAL FILE");

  // The safe headers still work — a gate that refused everything would pass
  // the tests above while making the tool useless.
  argvSeen = [];
  const ok = parse(
    await openExternal.execute({
      target: "mailto:a@example.com?subject=Build%20failed&body=see%20the%20log&cc=b@example.com",
    } as never),
  );
  expect(ok["outcome"]).toBe("handedOff");
  expect(argvSeen).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// the escalation scan — a guard that refuses data it was never meant to read
// ---------------------------------------------------------------------------

test("an allow-listed URL is not refused as privilege escalation for its path", async () => {
  // BEFORE THE FIX: `assertArgv` took `arg.split(/[\\/]/).pop()` of EVERY
  // element and matched it against sudo|doas|runas|pkexec, so
  // `https://docs.example.com/guides/sudo` — an https URL the scheme gate had
  // already approved — came back as `open exited -1: argv names "…", and this
  // package never escalates privilege`. A notification body of
  // "see /var/log/sudo" did the same on Linux.
  //
  // Both platforms, deliberately: macOS carries the target AFTER `open`'s
  // `--` while `xdg-open` has no `--` at all, so the URL sits in an option
  // position there. Only one of the two narrowings covers each.
  for (const platform of ["darwin", "linux"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    for (const target of [
      "https://docs.example.com/guides/sudo",
      "https://example.com/runas",
      "https://example.com/a?cmd=pkexec",
    ]) {
      argvSeen = [];
      const out = parse(await openExternal.execute({ target } as never));
      expect(out["outcome"]).toBe("handedOff");
      expect(argvSeen).toHaveLength(1);
    }
  }

  _setPlatform("linux");
  _setSessionEnv(X11);
  for (const body of [
    "see /var/log/sudo",
    "finished; check runas",
    // No whitespace and no `:` — this one is a plausible command path in
    // isolation, and is saved only by the OTHER half of the narrowing: it
    // sits after `notify-send`'s `--`, where this package only ever puts
    // positionals.
    "/var/log/sudo",
  ]) {
    argvSeen = [];
    const out = parse(await desktopNotify.execute({ title: "t", body } as never));
    expect(out["outcome"]).toBe("dispatched");
    const argv = argvSeen[0]?.argv ?? [];
    expect(argv).toContain(body);
    expect(argv.indexOf(body)).toBeGreaterThan(argv.indexOf("--"));
  }
});

test("the escalation guard still refuses an element that really names sudo", () => {
  // The other half of the fix above: narrowing the scan must not disarm it.
  // These are the shapes a future backend would get wrong.
  expect(assertArgv(["systemd-inhibit", "--what=idle", "sudo", "sleep", "60"])).toContain(
    "never escalates privilege",
  );
  expect(assertArgv(["systemd-inhibit", "/usr/bin/pkexec", "sleep"])).toContain(
    "never escalates privilege",
  );
  expect(assertArgv(["caffeinate", "runas.exe", "-t", "60"])).toContain(
    "never escalates privilege",
  );
  expect(assertArgv(["sudo", "caffeinate"])).toContain("never escalates privilege");
  expect(assertArgv(["sh", "-c", "echo"])).toContain("never runs a shell");
  // And an ordinary command still passes.
  expect(assertArgv(["lp", "-d", "Front_Desk", "/ws/report.pdf"])).toBeUndefined();
});

test("a refusal made before any process says so, instead of reporting an exit status", async () => {
  // BEFORE THE FIX: `assertArgv`'s rejection came back as
  // `{code:-1, missing:false}` with no `refused` flag, so every classifier
  // rendered it as "the notifier exited -1: argv may not contain a NUL byte"
  // — a claim that a process ran and returned a status, when nothing was
  // spawned at all.
  for (const platform of ["darwin", "linux"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    argvSeen = [];
    const out = parse(await desktopNotify.execute({ title: `a${NUL}b`, body: "body" } as never));
    expect(out["outcome"]).toBe("failed");
    expect(String(out["reason"])).toContain("NUL byte");
    expect(String(out["reason"])).not.toContain("exited");
    // And, the part that matters: nothing reached the runner.
    expect(argvSeen).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// the seam — "could not start it" is not "it is not installed"
// ---------------------------------------------------------------------------

test("a spawn that failed for a reason other than a missing name is not reported as absent", () => {
  // BEFORE THE FIX: `runHostCommand`'s catch set `missing: true` for EVERY
  // spawn error, so a program that is installed but not executable by this
  // user (EACCES), a name that resolves to a directory, or an argv over the
  // kernel's limit (E2BIG) all came back as "the program is not installed on
  // this host" — and WindowList then told an operator to install the wmctrl
  // they already have. Rule 6, one level below the tools.
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`spawn wmctrl ${code}`), { code });

  expect(classifySpawnError(errno("ENOENT")).missing).toBe(true);
  expect(classifySpawnError(errno("ENOTDIR")).missing).toBe(true);

  for (const code of ["EACCES", "EPERM", "E2BIG", "EMFILE", "ENOMEM"]) {
    const result = classifySpawnError(errno(code));
    expect(result.missing).toBe(false);
    // The errno is in the reason, so the caller is told what happened rather
    // than what to install.
    expect(result.stderr).toContain(code);
  }
  // An error with no errno at all is still not "absent".
  expect(classifySpawnError(new Error("something else")).missing).toBe(false);
});

// ---------------------------------------------------------------------------
// PowerAssertion — the state file, and what a probe is allowed to conclude
// ---------------------------------------------------------------------------

test("a state file that is not a complete record crashes nothing and is not 'none'", async () => {
  // BEFORE THE FIX: `readState` checked `pid` and `marker` and nothing else,
  // so a record with those two and a missing deadline was accepted — and then
  // `new Date(undefined).toISOString()` threw `RangeError: Invalid time
  // value` straight out of `execute`, on `status` AND on `release`. That is a
  // crash on exactly the path a caller reaches when the recorded assertion is
  // the thing that has gone wrong. `hold` had the quiet half: `now() <
  // state.expiresAt` against a non-number is false, so it overwrote the
  // record it should have refused to replace.
  const broken = [
    JSON.stringify({ pid: 4242, marker: "caffeinate" }),
    JSON.stringify({ pid: 4242, marker: "caffeinate", expiresAt: "soon", startedAt: 1 }),
    JSON.stringify({ pid: 0, marker: "caffeinate", startedAt: 1, expiresAt: 2 }),
    JSON.stringify({
      pid: 4242,
      marker: "caffeinate",
      backend: "caffeinate",
      platform: "darwin",
      scope: "elsewhere",
      startedAt: 1,
      expiresAt: 2,
      reason: null,
    }),
    "{not json",
  ];
  for (const text of broken) {
    for (const action of ["status", "release", "hold"] as const) {
      files = new Map([[STATE_FILE, text]]);
      detachSeen = [];
      argvSeen = [];
      const out = parse(await powerAssertion.execute({ action } as never));
      expect(out["outcome"]).toBe("unreadableState");
      // Nothing was signalled — the pid is the field that cannot be trusted.
      expect(argvSeen).toEqual([]);
      // Nothing was started either: a new holder would overwrite the only
      // record of the old one.
      expect(detachSeen).toEqual([]);
      // The file is left exactly as it was, for an operator to look at.
      expect(files.get(STATE_FILE)).toBe(text);
      expect(String(out["statePath"])).toContain("power-assertion.json");
    }
  }
  // A COMPLETE record still works, so the validator is not simply refusing
  // everything.
  files = new Map([
    [
      STATE_FILE,
      JSON.stringify({
        pid: 4242,
        marker: "caffeinate",
        backend: "caffeinate",
        platform: "darwin",
        scope: "system",
        startedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_600_000,
        reason: null,
      }),
    ],
  ]);
  answers["ps"] = { code: 0, stdout: "caffeinate -i -m -t 600\n" };
  const held = parse(await powerAssertion.execute({ action: "status" } as never));
  expect(held["outcome"]).toBe("held");
});

test("a probe that complained is not a probe that said the holder is gone", () => {
  // BEFORE THE FIX: any non-zero exit with an empty stdout read as "gone", so
  // `release` deleted the state file and answered "expired". Recorded on
  // macOS 26.6.2: `ps -o command= -p 999999` exits 1, prints nothing on
  // stdout and "ps: process id too large" on stderr.
  const probe = (over: Partial<RunResult>): RunResult => ({ ...OK, ...over });
  expect(
    classifyLiveness("caffeinate", probe({ code: 1, stderr: "ps: process id too large\n" })),
  ).toBe("unknown");
  // A silent non-zero exit is still the definite answer it always was.
  expect(classifyLiveness("caffeinate", probe({ code: 1 }))).toBe("gone");
});

test("a command line that merely mentions the holder is not the holder", async () => {
  // BEFORE THE FIX: `line.includes(marker)`. After a pid rollover that makes
  // `vim /home/max/notes/caffeinate.md` answer "alive", and `release` then
  // sends SIGTERM to the operator's editor — the exact failure the module
  // header promises this check prevents ("A PID IS NOT AN IDENTITY").
  expect(commandMatchesMarker("caffeinate -i -m -t 1800", "caffeinate")).toBe(true);
  expect(commandMatchesMarker("/usr/bin/caffeinate -i -m", "caffeinate")).toBe(true);
  expect(commandMatchesMarker("vim /home/max/notes/caffeinate.md", "caffeinate")).toBe(false);
  expect(commandMatchesMarker("node ./caffeinate-runner.js", "caffeinate")).toBe(false);
  // Windows is the one case where the substring test is the right one: the
  // holder IS powershell, and the generated type name is what makes it ours.
  expect(
    commandMatchesMarker('"C:\\Windows\\powershell.exe" -Command "class CHPwr{}"', "CHPwr"),
  ).toBe(true);
  expect(commandMatchesMarker("C:\\tools\\other.exe CHPwr", "CHPwr")).toBe(false);

  // End to end: a release against a pid now running something that merely
  // names the holder signals NOTHING and clears the record as stale.
  files = new Map([
    [
      STATE_FILE,
      JSON.stringify({
        pid: 4242,
        marker: "caffeinate",
        backend: "caffeinate",
        platform: "darwin",
        scope: "system",
        startedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_600_000,
        reason: null,
      }),
    ],
  ]);
  answers["ps"] = { code: 0, stdout: "vim /home/max/notes/caffeinate.md\n" };
  const out = parse(await powerAssertion.execute({ action: "release" } as never));
  expect(out["outcome"]).toBe("stale");
  expect(argvSeen.map((call) => call.argv[0])).toEqual(["ps"]);
  expect(argvSeen.some((call) => call.argv[0] === "kill")).toBe(false);
});

// ---------------------------------------------------------------------------
// the hostile default — both guards, separately
// ---------------------------------------------------------------------------

test("the runner-seam tie is load-bearing on its own, not only the NODE_ENV belt", () => {
  // MUTATION TESTING FOUND THIS ONE. `host.ts` describes the runner-seam tie
  // as "the primary guard" and `NODE_ENV` as "the belt under it", but
  // deleting the primary guard left the whole suite GREEN: under `bun test`
  // the belt answers first for every test, so nothing anywhere asserted that
  // the tie exists. A guard no test can distinguish from its absence is the
  // vacuous-guard shape this repo has shipped twice.
  //
  // So: open the belt deliberately (with a runner installed, so nothing can
  // spawn whatever the answer is) and check the tie still refuses. It fails
  // if `_runnerInstalled()` stops being consulted — which is the case where a
  // harness that is not `bun test`, or a future runner that does not set
  // NODE_ENV, would start inheriting the machine it happens to run on.
  _setPlatform(undefined);
  _setSessionEnv(undefined);
  // `sessionEnv`'s half of the tie needs a session variable to actually be
  // set, or the assertion below passes on this machine for the wrong reason:
  // a developer box with no DISPLAY answers HEADLESS_ENV whether the tie is
  // there or not, and the test would then be green on macOS and red on a
  // Linux CI box with a display — which is the very inheritance this guard
  // exists to stop.
  const savedDisplay = process.env["DISPLAY"];
  process.env["DISPLAY"] = ":99";
  _allowRealHost(true);
  try {
    // The runner from `beforeEach` is still installed.
    expect(hostPlatform()).toBe("unsupported");
    expect(sessionEnv()).toEqual(HEADLESS_ENV);
  } finally {
    // `afterEach` does this too; doing it here means a failure above cannot
    // leave the gate open for the next test in the file.
    _allowRealHost(false);
    // `Reflect.deleteProperty`, not `delete` (biome) and emphatically not
    // `= undefined`, which stores the STRING "undefined" in the real
    // environment and would leave every later test thinking there is an X11
    // display called "undefined".
    if (savedDisplay === undefined) Reflect.deleteProperty(process.env, "DISPLAY");
    else process.env["DISPLAY"] = savedDisplay;
  }
});

// ---------------------------------------------------------------------------
// the injection matrix, widened
// ---------------------------------------------------------------------------

/** Undo `escapeXmlText`, so a toast body can be compared to what was sent. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The values `index.test.ts`'s matrix does not carry, all of which change what
 * a machine DOES rather than what it shows if they reach the wrong layer.
 */
const WIDER_HOSTILE = [
  "back\\slash",
  "a && b",
  "a | b",
  "a < b > c",
  "a & b",
  "'single'",
  '"double"',
  "$HOME",
  "${IFS}",
  "%USERPROFILE%",
  "A".repeat(100_000),
];

test("the wider hostile matrix never reaches program text, on any platform", async () => {
  let programTexts = 0;
  let recordedArgvElements = 0;
  let commands = 0;
  for (const value of WIDER_HOSTILE) {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      _setPlatform(platform);
      _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
      argvSeen = [];
      await desktopNotify.execute({ title: "title", body: value } as never);
      expect(argvSeen).toHaveLength(1);
      const call = argvSeen[0] as Recorded;
      commands += 1;
      recordedArgvElements += call.argv.length;

      if (platform === "darwin") {
        // Every `-e` statement is program text; the value must be in none of
        // them, and must be present verbatim after the `--`.
        const cut = call.argv.indexOf("--");
        expect(cut).toBeGreaterThan(0);
        const statements = call.argv.slice(0, cut);
        for (const element of statements) {
          expect(element).not.toContain(value);
          programTexts += element === "-e" ? 0 : 1;
        }
        expect(call.argv.slice(cut + 1)).toContain(value);
      } else if (platform === "linux") {
        const cut = call.argv.indexOf("--");
        expect(cut).toBeGreaterThan(0);
        // Every option is the `--opt=value` form, so no value of a caller's
        // can ever be mistaken for the next option's argument.
        for (const element of call.argv.slice(1, cut)) {
          expect(element.startsWith("--")).toBe(true);
          expect(element).toContain("=");
        }
        expect(call.argv.slice(cut + 1)).toContain(value);
      } else {
        // Windows: the value is in the ENVIRONMENT, escaped into the XML
        // document, and nowhere in the argv.
        for (const element of call.argv) expect(element).not.toContain(value);
        const xml = call.env?.["CREWHAUS_TOAST_XML"] ?? "";
        expect(xml).toContain(escapeXmlText(value));
        // Exactly one <toast> element survives, whatever the body said.
        expect(xml.split("<toast>")).toHaveLength(2);
        // And the body round-trips: escaping did not eat the message.
        expect(unescapeXml(xml)).toContain(value);
      }
    }
  }
  // The matrix ran. 11 values x 3 platforms, and a program-text count a
  // vacuous run cannot reach: 4 non-`-e` elements before the `--` on each of
  // the 11 macOS calls (the program, "on run argv", the statement, "end run").
  expect(commands).toBe(33);
  expect(programTexts).toBe(44);
  expect(recordedArgvElements).toBeGreaterThan(200);
});

test("a NUL is refused wherever it would truncate an argument, and never sent", async () => {
  // A NUL cuts an argument at the syscall boundary, so a string that reads as
  // harmless in TypeScript arrives at the kernel shorter than it was checked.
  const sites: ReadonlyArray<[string, (v: string) => Promise<unknown>]> = [
    ["notify.body", (v) => desktopNotify.execute({ title: "t", body: v } as never)],
    ["open.target", (v) => openExternal.execute({ target: `https://a.example/${v}` } as never)],
    ["power.reason", (v) => powerAssertion.execute({ action: "hold", reason: v } as never)],
    ["print.printer", (v) => printDocument.execute({ path: "package.json", printer: v } as never)],
  ];
  let checked = 0;
  for (const platform of ["darwin", "linux"] as const) {
    _setPlatform(platform);
    _setSessionEnv(platform === "linux" ? X11 : HEADLESS_ENV);
    for (const [, call] of sites) {
      argvSeen = [];
      detachSeen = [];
      files = new Map();
      const out = parse(await call(`a${NUL}b`));
      expect(["failed", "refused", "unavailable"]).toContain(String(out["outcome"]));
      for (const sent of everythingSent()) expect(sent).not.toContain(NUL);
      checked += 1;
    }

    // `ClipboardWrite` is the deliberate exception and is asserted as one:
    // its payload travels on STDIN, which is a byte stream rather than an
    // argv element, so a NUL there truncates nothing and the write is real.
    // What must still hold is that the payload is not ALSO in an argv.
    argvSeen = [];
    const written = parse(await clipboardWrite.execute({ text: `a${NUL}b` } as never));
    expect(written["outcome"]).toBe("written");
    expect(argvSeen).toHaveLength(1);
    expect(argvSeen[0]?.stdin).toBe(`a${NUL}b`);
    for (const element of argvSeen[0]?.argv ?? []) expect(element).not.toContain(NUL);
    checked += 1;
  }
  expect(checked).toBe(10);
});
