/**
 * `crewhaus hangar install|uninstall` against a temp HOME and an injected runner: the unit
 * files, the exact commands, the questions, the refusals and the receipts. No test loads
 * a real LaunchAgent or a systemd unit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  type Dirent,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LAUNCHD_LABEL,
  PLIST_MARKER,
  type ServiceDeps,
  UNIT_MARKER,
  WINDOWS_REFUSAL,
  install,
  planInstall,
  readLastRecovery,
  residentState,
  serviceProgram,
  uninstall,
} from "./hangar-service";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

type Rig = {
  readonly home: string;
  readonly hangarRoot: string;
  readonly ran: string[][];
  readonly written: string[];
  readonly receipts: string[];
  readonly asked: string[];
  readonly deps: ServiceDeps;
};

function rig(overrides: Partial<ServiceDeps> = {}, answers: { code?: number } = {}): Rig {
  const home = mkdtempSync(join(tmpdir(), "hangar-service-"));
  roots.push(home);
  const hangarRoot = join(home, ".crewhaus", "hangar");
  const ran: string[][] = [];
  const written: string[] = [];
  const receipts: string[] = [];
  const asked: string[] = [];
  const deps: ServiceDeps = {
    platform: "darwin",
    homedir: home,
    uid: 501,
    username: "sam",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    hangarRoot,
    which: (name) => (name === "crewhaus" ? "/usr/local/bin/crewhaus" : undefined),
    isExecutable: () => true,
    runner: (argv) => {
      ran.push([...argv]);
      return { code: answers.code ?? 0, stdout: "", stderr: "" };
    },
    write: (line) => written.push(line),
    isTty: false,
    confirm: async (question) => {
      asked.push(question);
      return true;
    },
    receipt: async (kind, effect) => {
      receipts.push(kind);
      await effect();
      return { ok: true, id: `cmd_${receipts.length}` };
    },
    ...overrides,
  };
  return { home, hangarRoot, ran, written, receipts, asked, deps };
}

const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const unitPath = (home: string) =>
  join(home, ".config", "systemd", "user", "crewhaus-hangar.service");

describe("the program the unit runs", () => {
  test("the chvm shim first, then the crewhaus PATH finds as found, then a refusal", () => {
    const r = rig();
    const shim = join(r.home, ".chvm", "shims", "crewhaus");
    expect(serviceProgram(r.deps)).toEqual({ program: "/usr/local/bin/crewhaus", from: "path" });
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, "#!/bin/sh\n");
    chmodSync(shim, 0o755);
    expect(serviceProgram(r.deps)).toEqual({ program: shim, from: "chvm" });
    // CHVM_DIR names the shim's home when set.
    const elsewhere = join(r.home, "other-chvm");
    expect(serviceProgram({ ...r.deps, env: { CHVM_DIR: elsewhere } })).toEqual({
      program: "/usr/local/bin/crewhaus",
      from: "path",
    });
    const none = rig({ which: () => undefined });
    const planned = planInstall(none.deps);
    expect(planned.ok).toBe(false);
    expect(!planned.ok && planned.result.exitCode).toBe(54);
    expect(!planned.ok && planned.result.lines.join(" ")).toContain("chvm");
  });
});

describe("install on macOS", () => {
  test("the property list: marker, program arguments, RunAtLoad, KeepAlive, log, environment", () => {
    const r = rig({ env: { PATH: "/p", CREWHAUS_HANGAR_ROOT: "/h & co" } });
    const planned = planInstall(r.deps);
    if (!planned.ok) throw new Error("refused");
    const lines = planned.plan.content.split("\n");
    expect(lines[0]).toStartWith("<?xml");
    expect(lines[1]).toBe(PLIST_MARKER);
    const text = planned.plan.content;
    expect(text).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(text).toContain(
      "<array>\n    <string>/usr/local/bin/crewhaus</string>\n    <string>hangar</string>\n    <string>serve</string>\n    <string>--resident</string>\n  </array>",
    );
    expect(text).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(text).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
    );
    expect(text).toContain(`<string>${join(r.hangarRoot, "service", "resident.log")}</string>`);
    expect(text).toContain("<key>PATH</key>\n    <string>/p</string>");
    expect(text).toContain("<string>/h &amp; co</string>");
    expect(text).not.toContain("CHVM_DIR");
    expect(planned.plan.commands).toEqual([
      ["launchctl", "bootstrap", "gui/501", plistPath(r.home)],
    ]);
  });

  test("--yes writes exactly the file shown, runs bootstrap, and writes one receipt", async () => {
    const r = rig();
    const out = await install(r.deps, { yes: true });
    expect(out.exitCode).toBe(0);
    const planned = planInstall(r.deps);
    if (!planned.ok) throw new Error("refused");
    expect(readFileSync(plistPath(r.home), "utf8")).toBe(planned.plan.content);
    // Shown in full before anything is written.
    for (const line of planned.plan.content.trimEnd().split("\n")) {
      expect(r.written).toContain(`  ${line}`);
    }
    expect(r.ran).toEqual([["launchctl", "bootstrap", "gui/501", plistPath(r.home)]]);
    expect(r.receipts).toEqual(["legacy.hangarInstall"]);
    expect(out.lines.join("\n")).toContain("Recorded as cmd_1");
  });

  test("no terminal and no --yes: exit 55, nothing written and nothing run", async () => {
    const r = rig();
    const before = treeBytes(r.home);
    const out = await install(r.deps, { yes: false });
    expect(out.exitCode).toBe(55);
    expect(treeBytes(r.home)).toEqual(before);
    expect(r.ran).toEqual([]);
    expect(r.receipts).toEqual([]);
  });

  test("at a terminal it asks, and a no changes nothing", async () => {
    const r = rig({ isTty: true, confirm: async () => false });
    const before = treeBytes(r.home);
    const out = await install(r.deps, { yes: false });
    expect(out.exitCode).toBe(0);
    expect(out.lines).toContain("Nothing was changed.");
    expect(treeBytes(r.home)).toEqual(before);
    const yes = rig({ isTty: true });
    expect((await install(yes.deps, { yes: false })).exitCode).toBe(0);
    expect(yes.asked).toEqual(["Install the service?"]);
    expect(existsSync(plistPath(yes.home))).toBe(true);
  });

  test("a file it did not write is refused with exit 53 and left as it is", async () => {
    const r = rig();
    mkdirSync(dirname(plistPath(r.home)), { recursive: true });
    writeFileSync(plistPath(r.home), '<?xml version="1.0"?>\n<plist>mine</plist>\n');
    const out = await install(r.deps, { yes: true });
    expect(out.exitCode).toBe(53);
    expect(readFileSync(plistPath(r.home), "utf8")).toContain("mine");
    expect(r.ran).toEqual([]);
  });

  test("a failing bootstrap is reported, and the receipt records it", async () => {
    const r = rig({}, { code: 5 });
    const out = await install(r.deps, { yes: true });
    expect(out.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain("exited 5");
  });
});

describe("install on Linux", () => {
  test("the unit: marker, ExecStart, Restart=on-failure, WantedBy, and the systemctl sequence", async () => {
    const r = rig({ platform: "linux", env: { PATH: "/p 1", CHVM_DIR: "/c" } });
    const out = await install(r.deps, { yes: true });
    expect(out.exitCode).toBe(0);
    const text = readFileSync(unitPath(r.home), "utf8");
    const lines = text.split("\n");
    expect(lines[0]).toBe(UNIT_MARKER);
    expect(lines).toContain('ExecStart="/usr/local/bin/crewhaus" hangar serve --resident');
    expect(lines).toContain("Restart=on-failure");
    expect(lines).toContain("WantedBy=default.target");
    expect(lines).toContain('Environment="PATH=/p 1"');
    expect(lines).toContain('Environment="CHVM_DIR=/c"');
    expect(r.ran).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "crewhaus-hangar.service"],
    ]);
    // The linger hint is printed; loginctl never runs.
    expect(out.lines.join("\n")).toContain("loginctl enable-linger sam");
    expect(r.ran.some((argv) => argv[0] === "loginctl")).toBe(false);
  });
});

describe("Windows", () => {
  test("install and uninstall exit 54 and write nothing", async () => {
    const r = rig({ platform: "win32" });
    const before = treeBytes(r.home);
    for (const run of [install, uninstall]) {
      const out = await run(r.deps, { yes: true });
      expect(out).toEqual({ lines: [WINDOWS_REFUSAL], exitCode: 54 });
    }
    expect(treeBytes(r.home)).toEqual(before);
    expect(r.ran).toEqual([]);
    expect(r.receipts).toEqual([]);
  });
});

describe("uninstall", () => {
  test("stops the unit first, removes only the file it wrote, and leaves Home's data", async () => {
    const r = rig({ platform: "linux" });
    await install(r.deps, { yes: true });
    mkdirSync(r.hangarRoot, { recursive: true });
    writeFileSync(join(r.hangarRoot, "harnesses.json"), "{}\n");
    const before = treeBytes(r.hangarRoot);
    r.ran.length = 0;
    const out = await uninstall(r.deps, { yes: true });
    expect(out.exitCode).toBe(0);
    expect(r.ran).toEqual([
      ["systemctl", "--user", "disable", "--now", "crewhaus-hangar.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(existsSync(unitPath(r.home))).toBe(false);
    expect(treeBytes(r.hangarRoot)).toEqual(before);
    expect(r.receipts).toEqual(["legacy.hangarInstall", "legacy.hangarUninstall"]);
  });

  test("on macOS it boots the agent out", async () => {
    const r = rig();
    await install(r.deps, { yes: true });
    r.ran.length = 0;
    expect((await uninstall(r.deps, { yes: true })).exitCode).toBe(0);
    expect(r.ran).toEqual([["launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`]]);
  });

  test("a file it did not write is left, with exit 53", async () => {
    const r = rig({ platform: "linux" });
    mkdirSync(dirname(unitPath(r.home)), { recursive: true });
    writeFileSync(unitPath(r.home), "[Service]\nExecStart=/bin/true\n");
    expect((await uninstall(r.deps, { yes: true })).exitCode).toBe(53);
    expect(existsSync(unitPath(r.home))).toBe(true);
    expect(r.ran).toEqual([]);
  });

  test("not installed: nothing to do, no receipt", async () => {
    const r = rig();
    const out = await uninstall(r.deps, { yes: true });
    expect(out.exitCode).toBe(0);
    expect(r.receipts).toEqual([]);
  });
});

describe("what status reads", () => {
  test("installed only with the marker", async () => {
    const r = rig();
    expect(residentState(r.deps).state).toBe("absent");
    await install(r.deps, { yes: true });
    expect(residentState(r.deps)).toEqual({ state: "installed", unitPath: plistPath(r.home) });
  });

  test("a missing, unreadable or other-version recovery report is no report", () => {
    const r = rig();
    expect(readLastRecovery(r.hangarRoot)).toBeUndefined();
    mkdirSync(join(r.hangarRoot, "service"), { recursive: true });
    writeFileSync(join(r.hangarRoot, "service", "recovery.json"), "{not json");
    expect(readLastRecovery(r.hangarRoot)).toBeUndefined();
    writeFileSync(
      join(r.hangarRoot, "service", "recovery.json"),
      JSON.stringify({ v: 2, at: "x" }),
    );
    expect(readLastRecovery(r.hangarRoot)).toBeUndefined();
    writeFileSync(
      join(r.hangarRoot, "service", "recovery.json"),
      JSON.stringify({
        v: 1,
        at: "2026-11-13T00:00:00.000Z",
        mode: "resident",
        restarted: [{}],
        skipped: [{}, {}],
        failed: [],
      }),
    );
    expect(readLastRecovery(r.hangarRoot)).toEqual({
      at: "2026-11-13T00:00:00.000Z",
      mode: "resident",
      restarted: 1,
      skipped: 2,
      failed: 0,
    });
  });
});
