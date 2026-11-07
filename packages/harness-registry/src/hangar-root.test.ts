/**
 * The Hangar root, resolved once for the CLI, the fleet tools and the
 * runtime-state floor (`resolveHangarRoot`), and every Hangar root an
 * environment names, which the floor protects (`hangarStateRoots`).
 *
 * Pure functions of the environment handed in: nothing here touches the disk,
 * and every expectation is built with `resolve`/`join`, which add a drive
 * letter on Windows exactly as the functions do.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { hangarStateRoots, resolveHangarRoot } from "./hangar-root";
import {
  resolveHangarRoot as exportedHangarRoot,
  hangarStateRoots as exportedStateRoots,
} from "./index";

const DEFAULT = join(homedir(), ".crewhaus", "hangar");

/** Run `body` with `process.env[name]` set to `value`, then put it back as it was. */
function withProcessEnv<T>(name: string, value: string, body: () => T): T {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return body();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = saved;
  }
}

describe("resolveHangarRoot", () => {
  test("an explicit CREWHAUS_HANGAR_ROOT wins, else <registryRoot>/hangar", () => {
    expect(resolveHangarRoot({ CREWHAUS_HANGAR_ROOT: "/tmp/hr" })).toBe(resolve("/tmp/hr"));
    expect(resolveHangarRoot({ CREWHAUS_REGISTRY_ROOT: "/tmp/reg" })).toBe(
      join(resolve("/tmp/reg"), "hangar"),
    );
    expect(resolveHangarRoot({ CREWHAUS_REGISTRY_ROOT: "/srv/reg" })).toBe(
      join(resolve("/srv/reg"), "hangar"),
    );
    expect(
      resolveHangarRoot({
        CREWHAUS_REGISTRY_ROOT: "/srv/reg",
        CREWHAUS_HANGAR_ROOT: "/srv/hangar",
      }),
    ).toBe(resolve("/srv/hangar"));
  });

  test("an empty variable is ignored, and no variable at all is the default under the home directory", () => {
    expect(resolveHangarRoot({})).toBe(DEFAULT);
    expect(resolveHangarRoot({ CREWHAUS_HANGAR_ROOT: "" })).toBe(DEFAULT);
    expect(resolveHangarRoot({ CREWHAUS_REGISTRY_ROOT: "" })).toBe(DEFAULT);
    expect(
      resolveHangarRoot({ CREWHAUS_HANGAR_ROOT: "", CREWHAUS_REGISTRY_ROOT: "/srv/reg" }),
    ).toBe(join(resolve("/srv/reg"), "hangar"));
  });

  test("a relative CREWHAUS_HANGAR_ROOT resolves against the working directory", () => {
    const got = resolveHangarRoot({ CREWHAUS_HANGAR_ROOT: join("rel", "hangar") });
    expect(got).toBe(join(process.cwd(), "rel", "hangar"));
    expect(isAbsolute(got)).toBe(true);
  });

  test("with no environment handed in it reads process.env; handed one, only that", () => {
    const elsewhere = resolve("/srv/from-process-env");
    withProcessEnv("CREWHAUS_HANGAR_ROOT", elsewhere, () => {
      expect(resolveHangarRoot()).toBe(elsewhere);
      expect(resolveHangarRoot({})).toBe(DEFAULT);
    });
  });

  test("the package entry exports this resolver itself", () => {
    expect(exportedHangarRoot).toBe(resolveHangarRoot);
    expect(exportedStateRoots).toBe(hangarStateRoots);
  });
});

describe("hangarStateRoots: every Hangar root the environment names, and the default always", () => {
  const h = resolve("/srv/h");
  const r = resolve("/srv/r");
  const cases: ReadonlyArray<{
    readonly env: Readonly<Record<string, string>>;
    readonly roots: readonly string[];
  }> = [
    { env: {}, roots: [DEFAULT] },
    { env: { CREWHAUS_HANGAR_ROOT: h }, roots: [h, DEFAULT] },
    { env: { CREWHAUS_REGISTRY_ROOT: r }, roots: [join(r, "hangar"), DEFAULT] },
    {
      env: { CREWHAUS_HANGAR_ROOT: h, CREWHAUS_REGISTRY_ROOT: r },
      roots: [h, join(r, "hangar"), DEFAULT],
    },
    // Named twice, listed once.
    { env: { CREWHAUS_HANGAR_ROOT: DEFAULT }, roots: [DEFAULT] },
    { env: { CREWHAUS_HANGAR_ROOT: "", CREWHAUS_REGISTRY_ROOT: "" }, roots: [DEFAULT] },
  ];

  test("each environment, in order and without repeats", () => {
    expect(cases.map(({ env }) => ({ env, roots: hangarStateRoots(env) }))).toEqual(
      cases.map(({ env, roots }) => ({ env, roots: [...roots] })),
    );
  });

  test("a variable adds a root and never moves the default: every case keeps it, absolute", () => {
    for (const { env } of cases) {
      const roots = hangarStateRoots(env);
      expect({ env, holdsDefault: roots.includes(DEFAULT) }).toEqual({ env, holdsDefault: true });
      expect(roots.filter((root) => !isAbsolute(root))).toEqual([]);
    }
  });

  test("the first root is the one the CLI and the fleet tools open", () => {
    for (const { env } of cases) expect(hangarStateRoots(env)[0]).toBe(resolveHangarRoot(env));
  });

  test("with no environment handed in it reads process.env", () => {
    const elsewhere = resolve("/srv/from-process-env");
    withProcessEnv("CREWHAUS_HANGAR_ROOT", elsewhere, () => {
      expect(hangarStateRoots()).toContain(elsewhere);
      expect(hangarStateRoots({})).toEqual([DEFAULT]);
    });
  });
});
