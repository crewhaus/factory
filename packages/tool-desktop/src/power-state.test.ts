/**
 * The PowerAssertion record on a REAL filesystem (security-10#1).
 *
 * The record names the pid `release` signals, so it lives outside the
 * workspace in a directory only this user can write, and is read and written
 * without following anything planted there. `XDG_RUNTIME_DIR` points the
 * package at a temp directory, so nothing here touches a real runtime dir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HEADLESS_ENV, _resetHostSeams, _setClock, _setPlatform, _setSessionEnv } from "./host";
import { powerAssertion, powerStateFile } from "./index";
import { fs, StateFileError, _setFs } from "./lib/fsseam";
import { type RunRequest, _resetRunSeams, _setDetacher, _setRunner } from "./run";

let tmp: string;
let savedRuntime: string | undefined;
let ran: string[][];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "power-state-"));
  savedRuntime = process.env["XDG_RUNTIME_DIR"];
  process.env["XDG_RUNTIME_DIR"] = tmp;
  _setFs(undefined);
  _setPlatform("darwin");
  _setSessionEnv(HEADLESS_ENV);
  _setClock(() => 1_700_000_000_000);
  ran = [];
  _setRunner(async (request: RunRequest) => {
    ran.push([...request.argv]);
    return { code: 0, stdout: "sleep 300\n", stderr: "", timedOut: false, missing: false };
  });
  _setDetacher(async () => ({ ok: true, pid: 4242 }));
});

afterEach(() => {
  if (savedRuntime === undefined) Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR");
  else process.env["XDG_RUNTIME_DIR"] = savedRuntime;
  _resetHostSeams();
  _resetRunSeams();
  rmSync(tmp, { recursive: true, force: true });
});

/** Mode bits, FIFOs and unprivileged symlinks are POSIX facts; Windows has none of them. */
const posixTest = test.skipIf(process.platform === "win32");

const parse = (out: unknown): Record<string, unknown> =>
  JSON.parse(String(out)) as Record<string, unknown>;

posixTest(
  "the record lives in a private per-user directory outside the workspace, 0700/0600",
  async () => {
    const file = powerStateFile();
    expect(file.startsWith(join(tmp, "crewhaus"))).toBe(true);
    expect(file.startsWith(process.cwd())).toBe(false);
    expect(parse(await powerAssertion.execute({ action: "hold" } as never))["outcome"]).toBe(
      "held",
    );
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))["pid"]).toBe(4242);
  },
);

posixTest(
  "a symlink at the record's path is not followed: the state is unreadable, nothing is signalled",
  async () => {
    const file = powerStateFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const planted = join(tmp, "planted.json");
    writeFileSync(
      planted,
      JSON.stringify({
        pid: 4242,
        marker: "caffeinate",
        backend: "caffeinate",
        platform: "darwin",
        scope: "system",
        startedAt: 1,
        expiresAt: 2,
        reason: null,
      }),
    );
    symlinkSync(planted, file);
    const out = parse(await powerAssertion.execute({ action: "release" } as never));
    expect(out["outcome"]).toBe("unreadableState");
    expect(String(out["reason"])).toContain("symbolic link");
    expect(ran).toEqual([]);
  },
);

posixTest("a directory other users can write is not trusted", () => {
  const file = powerStateFile();
  mkdirSync(dirname(file), { recursive: true });
  chmodSync(dirname(file), 0o777);
  writeFileSync(file, "{}");
  expect(() => fs().readText(file)).toThrow(StateFileError);
  expect(() => fs().readText(file)).toThrow("can be written by other users");
});

posixTest("a directory others can read but not write is still trusted", () => {
  const file = powerStateFile();
  mkdirSync(dirname(file), { recursive: true });
  chmodSync(dirname(file), 0o755);
  writeFileSync(file, "{}");
  expect(fs().readText(file)).toBe("{}");
});

posixTest("a FIFO at the record's path is refused without blocking", async () => {
  const file = powerStateFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const mkfifo = Bun.spawnSync(["mkfifo", file]);
  if (mkfifo.exitCode !== 0) return; // no mkfifo on this host
  const out = parse(await powerAssertion.execute({ action: "status" } as never));
  expect(out["outcome"]).toBe("unreadableState");
  expect(String(out["reason"])).toContain("not trusted");
});

posixTest("a link planted at the old predictable temp name is not written through", async () => {
  const file = powerStateFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const victim = join(tmp, "victim");
  writeFileSync(victim, "ORIGINAL");
  symlinkSync(victim, `${file}.${process.pid}.tmp`);
  expect(parse(await powerAssertion.execute({ action: "hold" } as never))["outcome"]).toBe("held");
  expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
  expect(lstatSync(file).isFile()).toBe(true);
});
