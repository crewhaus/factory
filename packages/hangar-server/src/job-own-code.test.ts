/**
 * A Home job for a harness that does not run its own code runs Home's own `crewhaus`, which
 * takes no code or settings from the harness directory it runs in, and no job finds a
 * command through a `PATH` entry that depends on that directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createProcessOps } from "@crewhaus/harness-supervisor";
import { makeFixtureHarness } from "./fixture";
import { absolutePathEnv, defaultJobRunner, homeCrewhausArgv, jobCrewhausBin } from "./process";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const ctx = { register: () => undefined, isCancelled: () => false } as unknown as Parameters<
  ReturnType<typeof defaultJobRunner>
>[1];
const doctorJob = (dir: string) =>
  ({
    jobId: "job_00000000000000d1",
    harnessDir: dir,
    kind: "doctor",
    argv: ["doctor"],
    mutating: false,
    state: "running",
    enqueuedAt: "2026-11-12T00:00:00.000Z",
  }) as Parameters<ReturnType<typeof defaultJobRunner>>[0];

describe("homeCrewhausArgv", () => {
  test("a compiled crewhaus runs as itself", () => {
    expect(
      homeCrewhausArgv({
        execPath: "/opt/crewhaus",
        main: "/$bunfs/root/crewhaus",
        emptyConfig: "/dev/null",
      }),
    ).toEqual(["/opt/crewhaus"]);
    expect(
      homeCrewhausArgv({
        execPath: "C:\\crewhaus.exe",
        main: "B:\\~BUN\\root\\crewhaus.exe",
        emptyConfig: "C:\\h\\empty.toml",
      }),
    ).toEqual(["C:\\crewhaus.exe"]);
  });

  test("a Bun-run crewhaus reads no env file and an empty config", () => {
    expect(
      homeCrewhausArgv({
        execPath: "/opt/bun",
        main: "/opt/crewhaus/index.js",
        emptyConfig: "/dev/null",
      }),
    ).toEqual(["/opt/bun", "--no-env-file", "--config=/dev/null", "/opt/crewhaus/index.js"]);
  });

  test("anything else is not named", () => {
    expect(
      homeCrewhausArgv({ execPath: "/opt/node", main: "/x.js", emptyConfig: "/dev/null" }),
    ).toBe(undefined);
    expect(homeCrewhausArgv({ execPath: "/opt/bun", main: "x.js", emptyConfig: "/dev/null" })).toBe(
      undefined,
    );
  });
});

describe("absolutePathEnv", () => {
  test("keeps only absolute PATH entries, and nothing else changes", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const abs = process.platform === "win32" ? "C:\\bin" : "/usr/bin";
    expect(
      absolutePathEnv({ PATH: ["node_modules/.bin", ".", "", abs].join(sep), A: "1" }),
    ).toEqual({
      PATH: abs,
      A: "1",
    });
  });
});

describe.skipIf(process.platform === "win32")("a Home job's process", () => {
  test("a harness not adopted here never runs its bunfig preload or env-file loader settings in Home's crewhaus", async () => {
    const dir = makeFixtureHarness(join(temp("hangar-owncode-"), "h"), { specName: "not-adopted" });
    const marker = join(dir, "preloaded");
    writeFileSync(
      join(dir, "evil.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    writeFileSync(join(dir, ".env"), "NODE_OPTIONS=--max-old-space-size=64\n");
    // Home's own crewhaus, standing in: it records where it ran and what it was given.
    const entry = join(temp("hangar-home-cli-"), "index.ts");
    const seen = join(dir, "seen.json");
    writeFileSync(
      entry,
      `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS ?? null }));\n`,
    );
    const home = homeCrewhausArgv({
      execPath: process.execPath,
      main: entry,
      emptyConfig: "/dev/null",
    });
    expect(home).toBeDefined();
    const registry = { list: () => [{ dir, registeredAt: "2026-08-01T00:00:00.000Z" } as never] };
    const bin = jobCrewhausBin(registry, dir, {}, home);
    expect(bin).toEqual(home);
    const runner = defaultJobRunner(createProcessOps(), () => bin);
    const result = await runner(doctorJob(dir), ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
      cwd: dir,
      argv: ["doctor"],
      nodeOptions: null,
    });
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("a job's PATH holds only absolute entries, so a harness's own bun is never reached", async () => {
    const dir = makeFixtureHarness(join(temp("hangar-jobpath-"), "h"), { specName: "path" });
    const tools = temp("hangar-jobpath-bin-");
    for (const [root, who] of [
      [join(dir, "node_modules", ".bin"), "HARNESS"],
      [tools, "HOME"],
    ] as const) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "bun"), `#!/bin/sh\necho ${who}\n`);
      chmodSync(join(root, "bun"), 0o755);
    }
    // A shim that finds bun the way chvm's does.
    const shim = join(tools, "crewhaus-shim");
    const seen = join(dir, "seen.txt");
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s\\n%s\\n' "$PATH" "$(bun)" > ${JSON.stringify(seen)}\n`,
    );
    chmodSync(shim, 0o755);
    const path = process.env["PATH"];
    try {
      process.env["PATH"] = ["node_modules/.bin", tools, "/usr/bin", "/bin"].join(":");
      const runner = defaultJobRunner(createProcessOps(), () => [shim]);
      expect((await runner(doctorJob(dir), ctx)).exitCode).toBe(0);
    } finally {
      if (path === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env["PATH"] = path;
    }
    const [jobPath, ran] = readFileSync(seen, "utf8").trim().split("\n");
    expect(jobPath?.split(":").every((entry) => isAbsolute(entry))).toBe(true);
    expect(ran).toBe("HOME");
  }, 20_000);
});
