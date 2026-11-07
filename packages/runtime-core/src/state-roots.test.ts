/**
 * The runtime-state roots a run hands the floor (`runtimeStateRoots`): the
 * run's record, the files that control the run, the records its gates keep, its
 * environment files and start config, and Hangar's directory and registry file,
 * each spelled absolute, with links followed and workspace-relative.
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
import { protectedRootHolding } from "@crewhaus/tool-safety/fs";
import {
  declaredEnvFiles,
  relocatingFieldLeftOut,
  runtimeRecordRoots,
  runtimeStateRoots,
} from "./state-roots";

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
const GATE_RECORDS = [
  "approvals",
  "environments.json",
  "graders",
  "judge-calibration.json",
  "evals",
  "datasets",
  "retention.json",
  "audit",
  "graphs",
  "advice",
].map((name) => join(".crewhaus", name));
const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];
const START_CONFIG = ["bunfig.toml", ".npmrc"];
const CONTROL = [
  join(".crewhaus", "run"),
  join(".crewhaus", "settings.json"),
  ...GATE_RECORDS,
  ...ENV_FILES,
  ...START_CONFIG,
];

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
const DEFAULT_REGISTRY = join(homedir(), ".crewhaus", "harnesses.json");
const DEFAULT_SPELLINGS = [
  ...new Set([
    DEFAULT_HOME,
    followedOf(DEFAULT_HOME),
    DEFAULT_REGISTRY,
    followedOf(DEFAULT_REGISTRY),
  ]),
];

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

describe("what a harness's gates read, its environment files and its start config", () => {
  test("a neighbour of an exact file, and a file in a subdirectory, are no roots", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    for (const name of [
      join(".crewhaus", "approvals.jsonl"),
      join(".crewhaus", "environments.json.bak"),
      join(".crewhaus", "retention.json.bak"),
      join(".crewhaus", "graders.yaml"),
      join(".crewhaus", "advice.md"),
      ".env.example",
      ".env.sample",
      ".envrc",
      ".environment",
      join("sub", ".env"),
      "bunfig.toml.bak",
      ".npmrc.bak",
    ]) {
      expect({ name, relative: roots.includes(name) }).toEqual({ name, relative: false });
      expect({ name, absolute: roots.includes(join(cwd, name)) }).toEqual({
        name,
        absolute: false,
      });
      expect({ name, held: protectedRootHolding(name, roots, cwd) }).toEqual({
        name,
        held: undefined,
      });
    }
  });

  test("a directory and an exact file each hold what lies under them", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    for (const [path, root] of [
      [join(".crewhaus", "graders", "x", "index.ts"), join(".crewhaus", "graders")],
      [join(".crewhaus", "approvals", "s__prod.json"), join(".crewhaus", "approvals")],
      [join(".env", "x"), ".env"],
    ] as const) {
      const held = protectedRootHolding(path, roots, cwd);
      expect({ path, held: held === root || held === join(cwd, root) }).toEqual({
        path,
        held: true,
      });
    }
  });
});

describe("a managed run's tenants root", () => {
  test("is protected whole when the tenant has buildTenant's shape", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    for (const rel of [join(".crewhaus", "tenants"), join("live", "tenants")]) {
      const tenant = buildTenant("acme", { tenantsRoot: join(cwd, rel) });
      const roots = runtimeStateRoots(tenant.sessionRoot, tenant, cwd, {});
      expect(roots).toContain(join(cwd, rel));
      expect(roots).toContain(rel);
      // The whole root, not only this tenant's part of it.
      expect(protectedRootHolding(join(rel, "other", "sessions", "x"), roots, cwd)).toBeDefined();
      // The roots a tool's own store may lie in stay this tenant's alone.
      expect(runtimeRecordRoots(tenant.sessionRoot, tenant, cwd)).not.toContain(rel);
    }
  });

  test("outside the working directory it is spelled absolute alone", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const tenants = tempDir("crewhaus-state-roots-tenants-");
    const tenant = buildTenant("acme", { tenantsRoot: tenants });
    const roots = runtimeStateRoots(tenant.sessionRoot, tenant, cwd, {});
    expect(roots).toContain(tenants);
    expect(roots.filter((root) => !isAbsolute(root) && root.startsWith(".."))).toEqual([]);
  });

  test("an override moves the session root, and its parent is no tenants root", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const tenants = join(cwd, "live", "tenants");
    for (const sessionRoot of [
      // `.crewhaus` itself would be the parent of the parent of this one.
      join(cwd, ".crewhaus", "acme", "logs"),
      join(cwd, ".crewhaus", "sessions"),
      join(cwd, "acme", "sessions", "deep"),
    ]) {
      const tenant = buildTenant("acme", {
        tenantsRoot: tenants,
        overrides: { acme: { sessionRoot } },
      });
      const roots = runtimeStateRoots(tenant.sessionRoot, tenant, cwd, {});
      expect({ sessionRoot, walled: roots.includes(tenants) }).toEqual({
        sessionRoot,
        walled: false,
      });
      expect({ sessionRoot, walled: roots.includes(".crewhaus") }).toEqual({
        sessionRoot,
        walled: false,
      });
      expect({ sessionRoot, walled: roots.includes(join(cwd, "acme")) }).toEqual({
        sessionRoot,
        walled: false,
      });
    }
  });

  test("one that holds the working directory is left to the rules", () => {
    const tenants = tempDir("crewhaus-state-roots-tenants-");
    const cwd = join(tenants, "acme", "work");
    mkdirSync(cwd, { recursive: true });
    const tenant = buildTenant("acme", { tenantsRoot: tenants });
    expect(runtimeStateRoots(tenant.sessionRoot, tenant, cwd, {})).not.toContain(tenants);
    // The same for an override of the same shape, whose parent's parent is the workspace.
    const here = tempDir("crewhaus-state-roots-");
    const shaped = buildTenant("acme", {
      overrides: { acme: { sessionRoot: join(here, "acme", "sessions") } },
    });
    const roots = runtimeStateRoots(shaped.sessionRoot, shaped, here, {});
    expect(roots).not.toContain(here);
    expect(protectedRootHolding("notes.md", roots, here)).toBeUndefined();
  });

  test("no tenant, no root", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    expect(runtimeStateRoots(undefined, undefined, cwd, {})).not.toContain(
      join(".crewhaus", "tenants"),
    );
  });
});

describe("the approvals file beside session logs", () => {
  const APPROVALS = "approvals.jsonl";

  test("a default run adds nothing, and a session root elsewhere holds it already", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const elsewhere = tempDir("crewhaus-state-roots-sessions-");
    for (const sessionRootDir of [undefined, elsewhere, join(cwd, "logs")]) {
      const roots = runtimeStateRoots(sessionRootDir, undefined, cwd, {});
      expect({ sessionRootDir, named: roots.filter((r) => r.endsWith(APPROVALS)) }).toEqual({
        sessionRootDir,
        named: [],
      });
    }
  });

  test("a session root that holds the working directory keeps that one file", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const here = runtimeStateRoots(cwd, undefined, cwd, {});
    expect(here).toContain(join(cwd, APPROVALS));
    expect(here).toContain(APPROVALS);
    expect(here).not.toContain(cwd);
    // A relative setting resolves the same way.
    expect(runtimeStateRoots(".", undefined, cwd, {})).toContain(join(cwd, APPROVALS));

    const above = runtimeStateRoots(dirname(cwd), undefined, cwd, {});
    expect(above).toContain(join(dirname(cwd), APPROVALS));
    expect(above).not.toContain(dirname(cwd));
    expect(above).not.toContain(APPROVALS);
  });
});

describe("the files manager.envFiles declares", () => {
  const withSettings = (body: string): string => {
    const cwd = tempDir("crewhaus-state-roots-");
    mkdirSync(join(cwd, ".crewhaus"));
    writeFileSync(join(cwd, ".crewhaus", "settings.json"), body);
    return cwd;
  };

  test("each is protected, resolved against the working directory, and trimmed", () => {
    const elsewhere = join(tempDir("crewhaus-state-roots-shared-"), "fleet.env");
    const cwd = withSettings(
      JSON.stringify({
        manager: { envFiles: ["config/shared.env", `  ${elsewhere} `, "../sibling.env"] },
      }),
    );
    expect(declaredEnvFiles(cwd)).toEqual([
      join(cwd, "config", "shared.env"),
      elsewhere,
      join(dirname(cwd), "sibling.env"),
    ]);
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    expect(roots).toContain(join(cwd, "config", "shared.env"));
    expect(roots).toContain(join("config", "shared.env"));
    expect(roots).toContain(elsewhere);
    expect(roots).toContain(join(dirname(cwd), "sibling.env"));
  });

  test("a missing or malformed file, and a key or entry of the wrong type, read as nothing", () => {
    expect(declaredEnvFiles(tempDir("crewhaus-state-roots-"))).toEqual([]);
    for (const body of [
      "{not json",
      "null",
      "[]",
      '"text"',
      "{}",
      '{"manager":null}',
      '{"manager":[]}',
      '{"manager":"x"}',
      '{"manager":{}}',
      '{"manager":{"envFiles":"x.env"}}',
      '{"manager":{"envFiles":{"0":"x.env"}}}',
      '{"manager":{"envFiles":[1,null,{},[],"","   "]}}',
    ]) {
      expect({ body, files: declaredEnvFiles(withSettings(body)) }).toEqual({ body, files: [] });
    }
  });

  test("one bad entry leaves the entries around it", () => {
    const cwd = withSettings('{"manager":{"envFiles":["a.env",3,"b.env"]}}');
    expect(declaredEnvFiles(cwd)).toEqual([join(cwd, "a.env"), join(cwd, "b.env")]);
  });

  test("a declared `.` or `..` cannot wall off the working directory", () => {
    const cwd = withSettings('{"manager":{"envFiles":[".","..","kept.env"]}}');
    const roots = runtimeStateRoots(undefined, undefined, cwd, {});
    expect(roots).not.toContain(cwd);
    expect(roots).not.toContain(dirname(cwd));
    expect(roots).toContain(join(cwd, "kept.env"));
    expect(protectedRootHolding("notes.md", roots, cwd)).toBeUndefined();
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
    for (const root of [
      hangar,
      join(registry, "hangar"),
      join(registry, "harnesses.json"),
      ...DEFAULT_SPELLINGS,
    ]) {
      expect({ root, present: roots.includes(root) }).toEqual({ root, present: true });
    }
  });

  test("a registry root that holds the working directory protects its one file, not the directory", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, { CREWHAUS_REGISTRY_ROOT: cwd });
    expect(roots).toContain(join(cwd, "harnesses.json"));
    expect(roots).toContain("harnesses.json");
    expect(roots).not.toContain(cwd);
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
    // The record is a log field's own, and no other field's.
    for (const rel of RECORD) expect(out(STORE, { stateDir: rel })).toBe(false);
    expect(out(STORE, { stateDir: ".crewhaus/sessions/sub" })).toBe(false);
    expect(out(LOG, "not an object")).toBe(true);
    expect(out(LOG, { dir: "" })).toBe(false);
    expect(out(LOG, { dir: ["a"] })).toBe(false);
  });

  test("a log's field keeps its place when the run has moved the session directory", () => {
    const cwd = tempDir("crewhaus-state-roots-");
    const moved = join(cwd, "live", "sessions");
    const record = runtimeRecordRoots(moved, undefined, cwd);
    const all = runtimeStateRoots(moved, undefined, cwd, {});
    expect(relocatingFieldLeftOut(LOG, { dir: "live/sessions" }, record, all, cwd)).toBe(true);
    expect(relocatingFieldLeftOut(STORE, { stateDir: "live/sessions" }, record, all, cwd)).toBe(
      false,
    );
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

  describe("the gate record that is a field's own store", () => {
    const DATASETS = { field: "registryDir", kind: "path", default: ".crewhaus/datasets" };
    const EVALS = { field: "evalsDir", kind: "path", default: ".crewhaus/evals" };
    const roots = (cwd: string, env: Record<string, string> = {}) => ({
      record: runtimeRecordRoots(undefined, undefined, cwd),
      all: runtimeStateRoots(undefined, undefined, cwd, env),
    });

    test("is left out at its default and named, and it stays a root for everything else", () => {
      const cwd = tempDir("crewhaus-state-roots-");
      const { record, all } = roots(cwd);
      const out = (arg: typeof DATASETS, input: unknown) =>
        relocatingFieldLeftOut(arg, input, record, all, cwd);
      expect(all).toContain(join(".crewhaus", "datasets"));
      expect(all).toContain(join(".crewhaus", "evals"));
      expect(out(DATASETS, {})).toBe(true);
      expect(out(DATASETS, { registryDir: ".crewhaus/datasets" })).toBe(true);
      // Its own store is the one gate record: the record's roots are not it.
      for (const rel of RECORD) expect(out(DATASETS, { registryDir: rel })).toBe(false);
      expect(out(DATASETS, { registryDir: ".crewhaus/datasets/sub" })).toBe(true);
      expect(out(DATASETS, { registryDir: join(cwd, ".crewhaus", "datasets") })).toBe(true);
      expect(out(EVALS, {})).toBe(true);
      expect(out(EVALS, { evalsDir: ".crewhaus/evals" })).toBe(true);
      // Anywhere else the field is read as any path is.
      expect(out(DATASETS, { registryDir: "my/reg" })).toBe(false);
      expect(out(DATASETS, { registryDir: ".crewhaus" })).toBe(false);
      for (const dir of [
        ".crewhaus/evals",
        ".crewhaus/approvals",
        ".crewhaus/graders",
        ".crewhaus/run",
        ".crewhaus/settings.json",
        ".env",
        ".crewhaus/datasets/../approvals",
      ]) {
        expect({ dir, out: out(DATASETS, { registryDir: dir }) }).toEqual({ dir, out: false });
      }
      expect(out(EVALS, { evalsDir: ".crewhaus/datasets" })).toBe(false);
    });

    test("no other field's default makes a gate record its store", () => {
      const cwd = tempDir("crewhaus-state-roots-");
      const { record, all } = roots(cwd);
      const out = (arg: typeof STORE, input: unknown) =>
        relocatingFieldLeftOut(arg, input, record, all, cwd);
      expect(out(STORE, { stateDir: ".crewhaus/datasets" })).toBe(false);
      expect(out(STORE, { stateDir: ".crewhaus/evals" })).toBe(false);
      // A default that is a gate record and no tool's store is read too.
      const graders = { field: "dir", kind: "path", default: ".crewhaus/graders" };
      expect(out(graders, {})).toBe(false);
    });

    test("with Hangar's directory holding the working directory, its default is read", () => {
      const cwd = tempDir("crewhaus-state-roots-");
      const { record, all } = roots(cwd, { CREWHAUS_HANGAR_ROOT: cwd });
      expect(relocatingFieldLeftOut(DATASETS, {}, record, all, cwd)).toBe(false);
    });

    test("a link at the store into another root is read, and an operator's link above it is not", () => {
      const cwd = tempDir("crewhaus-state-roots-");
      mkdirSync(join(cwd, ".crewhaus", "run"), { recursive: true });
      symlinkSync("run", join(cwd, ".crewhaus", "datasets"));
      const linked = roots(cwd);
      expect(relocatingFieldLeftOut(DATASETS, {}, linked.record, linked.all, cwd)).toBe(false);

      const parent = tempDir("crewhaus-state-roots-");
      mkdirSync(join(parent, "data", "crew"), { recursive: true });
      symlinkSync(join("data", "crew"), join(parent, ".crewhaus"));
      const above = roots(parent);
      expect(relocatingFieldLeftOut(DATASETS, {}, above.record, above.all, parent)).toBe(true);
      expect(
        relocatingFieldLeftOut(
          DATASETS,
          { registryDir: "data/crew/approvals" },
          above.record,
          above.all,
          parent,
        ),
      ).toBe(false);
    });
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
