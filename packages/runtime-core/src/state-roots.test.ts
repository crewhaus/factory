/**
 * The runtime-state roots a run hands the floor (`runtimeStateRoots`): the
 * run's record, the files that control the run, and Hangar's directory, each
 * spelled absolute, with links followed and workspace-relative.
 *
 * Every case runs against a realpath'd temp working directory and passes an
 * explicit environment, so neither the machine's variables nor its real
 * Hangar root decide an answer. Nothing is created under the home directory:
 * the default Hangar root is only ever spelled.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { buildTenant } from "@crewhaus/tenancy";
import { relocatingFieldLeftOut, runtimeRecordRoots, runtimeStateRoots } from "./state-roots";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TMP.push(dir);
  return dir;
}

const RECORD = [
  join(".crewhaus", "sessions"),
  join(".crewhaus", "tool-results"),
  join(".crewhaus", "proofs"),
];
const CONTROL = [join(".crewhaus", "run"), join(".crewhaus", "settings.json")];

/** The default Hangar root, and its spelling with links followed as far as it exists. */
const DEFAULT_HOME = join(homedir(), ".crewhaus", "hangar");
function followedOf(path: string): string {
  const rest: string[] = [];
  let head = path;
  for (;;) {
    try {
      return rest.reduceRight((built, name) => join(built, name), realpathSync(head));
    } catch {
      if (dirname(head) === head) return path;
      rest.push(basename(head));
      head = dirname(head);
    }
  }
}
const DEFAULT_SPELLINGS = [...new Set([DEFAULT_HOME, followedOf(DEFAULT_HOME)])];

/** Run `body` with `process.env` carrying `vars`, then put every one back as it was. */
function withProcessEnv<T>(vars: Readonly<Record<string, string>>, body: () => T): T {
  const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  try {
    return body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

describe("the run's record", () => {
  test("is spelled as before: each root absolute and workspace-relative, in the same order, first", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    expect(roots.slice(0, 6)).toEqual(RECORD.flatMap((rel) => [join(cwd, rel), rel]));
  });

  test("a root that holds the working directory is still left to the rules", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    for (const sessionRootDir of [cwd, dirname(cwd)]) {
      const roots = runtimeStateRoots(sessionRootDir, undefined, cwd, {});
      expect({ sessionRootDir, kept: roots.includes(sessionRootDir) }).toEqual({
        sessionRootDir,
        kept: false,
      });
      expect(roots).not.toContain(join(cwd, ".crewhaus", "sessions"));
      expect(roots).toContain(join(cwd, ".crewhaus", "tool-results"));
    }
  });
});

describe("the files that control the run", () => {
  test("the run directory and the settings file, absolute and relative, whatever the tenant", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const tenants = tempDir("crewhaus-state-roots-tenants-");
    const tenant = buildTenant("acme", { tenantsRoot: tenants });
    for (const [label, roots] of [
      ["no tenant", runtimeStateRoots(undefined, undefined, cwd, {})],
      ["a tenant", runtimeStateRoots(tenant.sessionRoot, tenant, cwd, {})],
    ] as const) {
      for (const rel of CONTROL) {
        expect({ label, rel, absolute: roots.includes(join(cwd, rel)) }).toEqual({
          label,
          rel,
          absolute: true,
        });
        expect({ label, rel, relative: roots.includes(rel) }).toEqual({
          label,
          rel,
          relative: true,
        });
      }
    }
    // The tenant moves the record out of the workspace, and only the record.
    const scoped = runtimeStateRoots(tenant.sessionRoot, tenant, cwd, {});
    expect(scoped).toContain(tenant.sessionRoot);
    expect(scoped).toContain(tenant.toolResultRoot);
    expect(scoped.filter((root) => RECORD.includes(root))).toEqual([]);
  });

  test("a link an operator made, at `.crewhaus` or at the settings file, adds where it leads", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const elsewhere = tempDir("crewhaus-state-roots-target-");
    symlinkSync(elsewhere, join(cwd, ".crewhaus"));
    const viaDir = runtimeStateRoots(undefined, undefined, cwd, {});
    for (const name of ["run", "settings.json"]) {
      expect(viaDir).toContain(join(elsewhere, name));
      expect(viaDir).toContain(join(cwd, ".crewhaus", name));
      expect(viaDir).toContain(join(".crewhaus", name));
    }

    const cwd2 = tempDir("crewhaus-state-roots-");
    mkdirSync(join(cwd2, ".crewhaus"));
    const shared = join(elsewhere, "shared-settings.json");
    writeFileSync(shared, "{}");
    symlinkSync(shared, join(cwd2, ".crewhaus", "settings.json"));
    expect(runtimeStateRoots(undefined, undefined, cwd2, {})).toContain(shared);
  });
});

describe("Hangar's directory", () => {
  test("every root both variables name is protected, and the default always", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const hangar = tempDir("crewhaus-state-roots-hangar-");
    const registry = tempDir("crewhaus-state-roots-registry-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {
      CREWHAUS_HANGAR_ROOT: hangar,
      CREWHAUS_REGISTRY_ROOT: registry,
    });
    for (const root of [hangar, join(registry, "hangar"), ...DEFAULT_SPELLINGS]) {
      expect({ root, present: roots.includes(root) }).toEqual({ root, present: true });
    }
  });

  test("a control file behind an operator's link has a workspace-relative name of its own", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    mkdirSync(join(cwd, "data", "crew"), { recursive: true });
    symlinkSync(join("data", "crew"), join(cwd, ".crewhaus"));
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    for (const root of [
      join("data", "crew", "settings.json"),
      join("data", "crew", "run"),
      join(".crewhaus", "settings.json"),
      join(".crewhaus", "run"),
    ]) {
      expect({ root, present: roots.includes(root) }).toEqual({ root, present: true });
    }
  });

  test("a Hangar directory named through a link has the relative name of where it leads", () => {
    const base = tempDir("crewhaus-state-roots-");
    const cwd = join(base, "ws");
    mkdirSync(join(cwd, "a", "h"), { recursive: true });
    symlinkSync(cwd, join(base, "via"));
    const roots = runtimeStateRoots(undefined, undefined, cwd, {
      CREWHAUS_HANGAR_ROOT: join(base, "via", "a", "h"),
    });
    expect(roots).toContain(join("a", "h"));
    expect(roots).toContain(join(base, "via", "a", "h"));
    expect(roots).toContain(join(cwd, "a", "h"));
  });

  test("a followed root outside the working directory has no relative spelling", () => {
    const base = tempDir("crewhaus-state-roots-");
    const cwd = join(base, "ws");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(base, "crew"), { recursive: true });
    symlinkSync(join(base, "crew"), join(cwd, ".crewhaus"));
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    expect(roots).toContain(join(base, "crew", "run"));
    expect(
      roots.filter((root) => !isAbsolute(root) && root.includes("crew") && root.startsWith("..")),
    ).toEqual([]);
  });

  test("a variable pointing elsewhere adds its root and keeps the default", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const hangar = tempDir("crewhaus-state-roots-hangar-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, { CREWHAUS_HANGAR_ROOT: hangar });
    expect(roots).toContain(hangar);
    // The registry's Hangar root is the default one here: no registry root is named.
    for (const root of DEFAULT_SPELLINGS) expect(roots).toContain(root);
  });

  test("with no variables, the default is the only root beside the record and the control files", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    const workspace = [...RECORD, ...CONTROL].flatMap((rel) => [join(cwd, rel), rel]);
    expect(roots.filter((root) => !workspace.includes(root))).toEqual(DEFAULT_SPELLINGS);
  });

  test("one inside the working directory is also spelled relative", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {
      CREWHAUS_HANGAR_ROOT: join(cwd, "home"),
    });
    expect(roots).toContain(join(cwd, "home"));
    expect(roots).toContain("home");
  });

  test("one that holds the working directory, or is it, stays protected, absolute alone", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    for (const home of [cwd, dirname(cwd)]) {
      const roots = runtimeStateRoots(undefined, undefined, cwd, { CREWHAUS_HANGAR_ROOT: home });
      expect({ home, kept: roots.includes(home) }).toEqual({ home, kept: true });
      // No spelling of it relative to the workspace: not "", ".", nor a climb out.
      const back = relative(cwd, home);
      expect(roots.filter((root) => root === back || root === "." || root === "")).toEqual([]);
      expect(roots.filter((root) => !isAbsolute(root) && root.startsWith(".."))).toEqual([]);
    }
  });

  test("the two variables are read from the environment handed in, never from process.env", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const fromProcess = tempDir("crewhaus-state-roots-process-");
    const handedIn = tempDir("crewhaus-state-roots-handed-");
    withProcessEnv(
      {
        CREWHAUS_HANGAR_ROOT: join(fromProcess, "hangar"),
        CREWHAUS_REGISTRY_ROOT: join(fromProcess, "registry"),
      },
      () => {
        const explicit = runtimeStateRoots(undefined, undefined, cwd, {
          CREWHAUS_HANGAR_ROOT: handedIn,
        });
        expect(explicit).toContain(handedIn);
        expect(explicit.filter((root) => root.startsWith(fromProcess))).toEqual([]);
        // Handed nothing, the run's own environment is the one read.
        const ambient = runtimeStateRoots(undefined, undefined, cwd);
        expect(ambient).toContain(join(fromProcess, "hangar"));
        expect(ambient).toContain(join(fromProcess, "registry", "hangar"));
      },
    );
  });
});

describe("runtimeRecordRoots and the store a relocating field names", () => {
  const STORE = { field: "stateDir", kind: "path", default: ".crewhaus/state" };
  const LOG = { field: "dir", kind: "path", default: ".crewhaus/sessions" };

  test("the record's roots are spelled as the state roots spell them, and hold no control file", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const record = runtimeRecordRoots(undefined, undefined, cwd);
    const all = runtimeStateRoots(undefined, undefined, cwd, {});
    for (const rel of RECORD) {
      expect(record).toContain(rel);
      expect(record).toContain(join(cwd, rel));
    }
    expect(record.filter((root) => !all.includes(root))).toEqual([]);
    for (const rel of CONTROL) expect(record).not.toContain(rel);
  });

  test("a record root that holds the working directory is no record root", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    expect(runtimeRecordRoots(cwd, undefined, cwd)).not.toContain(cwd);
  });

  test("a store in the record is left out, named or at its default, and any other is read", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const record = runtimeRecordRoots(undefined, undefined, cwd);
    const all = runtimeStateRoots(undefined, undefined, cwd, {});
    const out = (arg: typeof LOG, input: unknown) =>
      relocatingFieldLeftOut(arg, input, record, all, cwd);
    expect(out(LOG, {})).toBe(true);
    expect(out(LOG, { dir: ".crewhaus/sessions/sub" })).toBe(true);
    expect(out(LOG, { dir: join(cwd, ".crewhaus", "proofs") })).toBe(true);
    expect(out(LOG, { dir: ".crewhaus/run" })).toBe(false);
    expect(out(LOG, { dir: ".crewhaus/sessions/../run" })).toBe(false);
    expect(out(STORE, {})).toBe(false);
    expect(out(STORE, { stateDir: "my/state" })).toBe(false);
    expect(out(LOG, "not an object")).toBe(true);
    expect(out(LOG, { dir: "" })).toBe(false);
    expect(out(LOG, { dir: ["a"] })).toBe(false);
  });

  test("a store in the record that also lies in Hangar's directory is read", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const record = runtimeRecordRoots(undefined, undefined, cwd);
    const all = runtimeStateRoots(undefined, undefined, cwd, { CREWHAUS_HANGAR_ROOT: cwd });
    expect(relocatingFieldLeftOut(LOG, {}, record, all, cwd)).toBe(false);
  });

  test("a store the record's name leads out of through a link is read", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    mkdirSync(join(cwd, ".crewhaus", "sessions"), { recursive: true });
    mkdirSync(join(cwd, ".crewhaus", "run"), { recursive: true });
    symlinkSync(join("..", "run"), join(cwd, ".crewhaus", "sessions", "away"));
    const record = runtimeRecordRoots(undefined, undefined, cwd);
    const all = runtimeStateRoots(undefined, undefined, cwd, {});
    expect(relocatingFieldLeftOut(LOG, { dir: ".crewhaus/sessions/away" }, record, all, cwd)).toBe(
      false,
    );
  });

  test("a store the tool reads whole, a service, and a nested field", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const record = runtimeRecordRoots(undefined, undefined, cwd);
    const all = runtimeStateRoots(undefined, undefined, cwd, {});
    const whole = { ...LOG, beneath: "all" };
    expect(relocatingFieldLeftOut(whole, { dir: ".crewhaus/run" }, record, all, cwd)).toBe(true);
    const url = { field: "endpoint", kind: "url", default: "https://example.test" };
    expect(relocatingFieldLeftOut(url, {}, record, all, cwd)).toBe(true);
    const nested = { ...LOG, field: "a.b" };
    expect(relocatingFieldLeftOut(nested, {}, record, all, cwd)).toBe(false);
  });
});
