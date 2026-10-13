/**
 * DownloadFile's temp file cannot be a door out of the workspace (C161,
 * security-8#13).
 *
 * 0.7.0 staged the download at `<dest>.crewhaus-part-<pid>-<n>`, a name
 * anyone who knows the destination and the daemon's pid can predict (the
 * counter starts at 0 in each process), wrote it with a plain open, and
 * renamed it over the destination. A symlink planted at that name carried
 * the bytes out of the workspace — creating a file there, or overwriting
 * one — and the rename then put the planted LINK at the destination; a hard
 * link truncated a file outside. Every time the result reported the
 * in-workspace path, so neither the approval prompt nor the result showed
 * the escape. The containment check only ever looked at the destination.
 *
 * The write now goes through @crewhaus/tool-safety/fs writeFileSafe: an
 * O_EXCL|O_NOFOLLOW temp under a random name, renamed into place.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  downloadFile,
  registerHttpConfig,
} from "./index";

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("hello world"),
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const originalCwd = process.cwd();
let workspace = "";
let outsider = "";

beforeEach(() => {
  // realpath: macOS's tmpdir is itself behind a link.
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-http-part-")));
  outsider = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-http-part-out-")));
  process.chdir(workspace);
  __setPrivateHostsAllowedForTest(true);
  registerHttpConfig({ allowed_origins: [origin] });
});

afterEach(() => {
  process.chdir(originalCwd);
  __setPrivateHostsAllowedForTest(false);
  _resetHttpConfig();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsider, { recursive: true, force: true });
});

/**
 * Every name 0.7.0 could have staged `dest` at in this process: the counter
 * is module state that earlier tests have already advanced, so plant the
 * whole range.
 */
const PLANTED = 512;
const partialNames = (dest: string): string[] =>
  Array.from({ length: PLANTED }, (_, n) =>
    path.join(workspace, `${dest}.crewhaus-part-${process.pid}-${n}`),
  );

async function download(dest: string, overwrite = false): Promise<string> {
  return String(
    await downloadFile.execute(
      { url: `${origin}/file`, path: dest, ...(overwrite ? { overwrite } : {}) },
      {} as never,
    ),
  );
}

describe("DownloadFile's staging file (C161)", () => {
  test("dangling links planted at the old partial names create nothing outside", async () => {
    const planted = partialNames("out.bin");
    planted.forEach((name, n) => symlinkSync(path.join(outsider, `p${n}.txt`), name));

    const out = JSON.parse(await download("out.bin"));
    expect(out.bytes).toBe(11);
    expect(readdirSync(outsider)).toEqual([]);
    const dest = lstatSync(path.join(workspace, "out.bin"));
    expect(dest.isSymbolicLink()).toBe(false);
    expect(dest.nlink).toBe(1);
    expect(readFileSync(path.join(workspace, "out.bin"), "utf8")).toBe("hello world");
    // The tool removes only what it created: the planted links are left,
    // and nothing else of its own is.
    expect(planted.every((name) => lstatSync(name).isSymbolicLink())).toBe(true);
    expect(readdirSync(workspace).length).toBe(PLANTED + 1);
  });

  test("a live link or a hard link at the old partial names cannot overwrite a file outside", async () => {
    writeFileSync(path.join(outsider, "keys"), "original");
    writeFileSync(path.join(outsider, "config"), "original");
    for (const name of partialNames("a.bin")) symlinkSync(path.join(outsider, "keys"), name);
    for (const name of partialNames("b.bin")) linkSync(path.join(outsider, "config"), name);

    expect(JSON.parse(await download("a.bin")).bytes).toBe(11);
    expect(JSON.parse(await download("b.bin")).bytes).toBe(11);

    expect(readFileSync(path.join(outsider, "keys"), "utf8")).toBe("original");
    expect(readFileSync(path.join(outsider, "config"), "utf8")).toBe("original");
    expect(lstatSync(path.join(workspace, "a.bin")).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(workspace, "b.bin")).nlink).toBe(1);
  });

  test("an overwrite replaces the destination file, not a file its old name was linked to", async () => {
    writeFileSync(path.join(workspace, "there.bin"), "old");
    for (const name of partialNames("there.bin")) {
      symlinkSync(path.join(outsider, "victim"), name);
    }
    expect(JSON.parse(await download("there.bin", true)).bytes).toBe(11);
    expect(readFileSync(path.join(workspace, "there.bin"), "utf8")).toBe("hello world");
    expect(existsSync(path.join(outsider, "victim"))).toBe(false);
  });

  test("a directory where the file should go is refused, and nothing is written", async () => {
    const dir = path.join(workspace, "dir.bin");
    mkdirSync(dir);
    const out = await download("dir.bin", true);
    expect(out).toContain("nothing was written");
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(workspace)).toEqual(["dir.bin"]);
  });
});
