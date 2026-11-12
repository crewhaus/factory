import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { protectedRootHolding } from "@crewhaus/tool-safety/fs";
import { discloseSurfaceChange, surfaceRecordDir } from "./surface-disclosure";

const SPEC = `name: disclosed
target: cli
agent:
  model: claude-opus-5
  instructions: You help.
permissions:
  allow: [Read]
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(text = SPEC): string {
  const dir = mkdtempSync(join(tmpdir(), "surface-disclosure-"));
  dirs.push(dir);
  const spec = join(dir, "crewhaus.yaml");
  writeFileSync(spec, text);
  return spec;
}

function start(spec: string, text: string): { lines: string[]; kind: string } {
  const lines: string[] = [];
  const out = discloseSurfaceChange(spec, text, {
    stderr: (line) => lines.push(line),
    now: () => new Date("2026-11-12T00:00:00Z"),
  });
  return { lines, kind: out.kind };
}

describe("crewhaus run's start-up disclosure of security settings", () => {
  test("a first start records the settings and says nothing", () => {
    const spec = harness();
    expect(start(spec, SPEC)).toEqual({ lines: [], kind: "recorded" });
    const record = join(surfaceRecordDir(spec), "surfaces.json");
    const kept = JSON.parse(readFileSync(record, "utf8")) as { surfaces: Record<string, string> };
    expect(Object.keys(kept.surfaces)).toContain("permissions");
    if (process.platform !== "win32") expect(statSync(record).mode & 0o777).toBe(0o600);
  });

  test("a start with the same settings says nothing", () => {
    const spec = harness();
    start(spec, SPEC);
    const instructionsOnly = SPEC.replace("You help.", "You help kindly.");
    expect(start(spec, instructionsOnly)).toEqual({ lines: [], kind: "unchanged" });
  });

  test("a changed permission is named once, by setting and file, never by value", () => {
    const spec = harness();
    start(spec, SPEC);
    const changed = SPEC.replace("allow: [Read]", "allow: [Read, SENTINEL_TOOL_7]");
    const first = start(spec, changed);
    expect(first.kind).toBe("changed");
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toBe(
      "crewhaus: security settings in crewhaus.yaml changed since the last start: permissions. Review them before you rely on this run.",
    );
    expect(first.lines[0]).not.toContain("SENTINEL");
    expect(start(spec, changed)).toEqual({ lines: [], kind: "unchanged" });
  });

  test("a record that cannot be written is one warning, and the run goes on", () => {
    const spec = harness();
    const runDir = join(surfaceRecordDir(spec), "..");
    mkdirSync(runDir, { recursive: true });
    // A file where the record's directory belongs.
    writeFileSync(surfaceRecordDir(spec), "not a directory");
    const out = start(spec, SPEC);
    expect(out.kind).toBe("warned");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("warning");
  });

  test("a record that cannot be read is one warning, and is written again", () => {
    const spec = harness();
    mkdirSync(surfaceRecordDir(spec), { recursive: true });
    writeFileSync(join(surfaceRecordDir(spec), "surfaces.json"), "{ torn");
    const out = start(spec, SPEC);
    expect(out.kind).toBe("warned");
    expect(out.lines).toHaveLength(1);
    expect(start(spec, SPEC)).toEqual({ lines: [], kind: "unchanged" });
  });

  test("started in the spec's directory, the record is inside the run directory the floor protects", () => {
    const spec = harness();
    const cwd = realpathSync(join(spec, ".."));
    start(spec, SPEC);
    const record = join(surfaceRecordDir(spec), "surfaces.json");
    expect(existsSync(record)).toBe(true);
    // `.crewhaus/run` under the run's working directory is a floor root.
    expect(relative(cwd, record).startsWith(join(".crewhaus", "run") + sep)).toBe(true);
    expect(protectedRootHolding(record, [join(cwd, ".crewhaus", "run")], cwd)).toBeDefined();
  });
});

describe("crewhaus dev", () => {
  test("its help says it reloads every change, security settings included, and is for development", async () => {
    const cli = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");
    const proc = Bun.spawn([process.execPath, cli, "dev", "--help"], {
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout.replace(/\s+/g, " ")).toContain(
      "dev reloads every spec change, security settings included, and is for development",
    );
  }, 20_000); // starts the CLI in a child process
});
