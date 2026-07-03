/**
 * Section 28 — `migration-engine` tests:
 *  - T1 round-trip per registered migration
 *  - T4 fixture corpus replay
 */
import { describe, expect, test } from "bun:test";
import { MigrationEngine, MigrationError, NOOP_0_TO_1, createDefaultEngine } from "./index";

describe("migration-engine — T1 single-step migrations", () => {
  test("0 → 1 NOOP migrates and stamps version", () => {
    const e = createDefaultEngine();
    const out = e.migrate({ name: "x", target: "cli" }, 1);
    expect(out.version).toBe(1);
  });

  test("up + down round-trip", () => {
    const e = createDefaultEngine();
    const original = { name: "x", target: "cli", version: 0 };
    const up = e.migrate(original, 1);
    expect(up.version).toBe(1);
    const back = e.migrate(up, 0);
    expect(back.version).toBe(0);
  });

  test("from === to is a no-op", () => {
    const e = createDefaultEngine();
    const spec = { version: 0 };
    expect(e.migrate(spec, 0)).toBe(spec);
  });

  test("missing version step throws", () => {
    const e = new MigrationEngine();
    expect(() => e.migrate({ version: 0 }, 1)).toThrow(MigrationError);
  });

  test("registering same key twice throws", () => {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    expect(() => e.register(NOOP_0_TO_1)).toThrow(MigrationError);
  });

  test("registering same-version migration throws", () => {
    const e = new MigrationEngine();
    expect(() =>
      e.register({
        from: 0,
        to: 0,
        up: (s) => s,
        down: (s) => s,
      }),
    ).toThrow(MigrationError);
  });

  test("registering >1-step migration throws", () => {
    const e = new MigrationEngine();
    expect(() =>
      e.register({
        from: 0,
        to: 2,
        up: (s) => s,
        down: (s) => s,
      }),
    ).toThrow(MigrationError);
  });
});

describe("migration-engine — T4 multi-step chain replay", () => {
  test("0 → 2 walks 0→1 then 1→2", () => {
    const e = new MigrationEngine();
    e.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1, addedAt1: true }),
      down: (s) => ({ ...s, version: 0 }),
    });
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2, addedAt2: true }),
      down: (s) => ({ ...s, version: 1 }),
    });
    const out = e.migrate({ version: 0 }, 2);
    expect(out.version).toBe(2);
    expect((out as { addedAt1?: boolean }).addedAt1).toBe(true);
    expect((out as { addedAt2?: boolean }).addedAt2).toBe(true);
  });

  test("2 → 0 walks 1→2.down then 0→1.down", () => {
    const e = new MigrationEngine();
    e.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1 }),
      down: (s) => ({ ...s, version: 0, removedAt0: true }),
    });
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1, removedAt1: true }),
    });
    const out = e.migrate({ version: 2 }, 0);
    expect(out.version).toBe(0);
    expect((out as { removedAt0?: boolean }).removedAt0).toBe(true);
    expect((out as { removedAt1?: boolean }).removedAt1).toBe(true);
  });

  test("list returns sorted migration keys", () => {
    const e = createDefaultEngine();
    e.register({
      from: 1,
      to: 2,
      up: (s) => s,
      down: (s) => s,
    });
    expect(e.list()).toEqual(["0→1", "1→2"]);
  });

  test("clear empties the registry", () => {
    const e = createDefaultEngine();
    expect(e.list()).toEqual(["0→1"]);
    e.clear();
    expect(e.list()).toEqual([]);
    // After clearing, the previously-registered step is gone.
    expect(() => e.migrate({ version: 0 }, 1)).toThrow(MigrationError);
  });
});

describe("migration-engine — additional coverage", () => {
  test("NOOP_0_TO_1.up stamps version 1 and preserves other keys", () => {
    const out = NOOP_0_TO_1.up({ name: "x", version: 0 });
    expect(out).toEqual({ name: "x", version: 1 });
  });

  test("NOOP_0_TO_1.down stamps version 0 and preserves other keys", () => {
    const out = NOOP_0_TO_1.down({ name: "x", version: 1 });
    expect(out).toEqual({ name: "x", version: 0 });
  });

  test("migrate treats a spec with no version field as version 0", () => {
    const e = createDefaultEngine();
    // No `version` key at all -> fromVersion defaults to 0, so 0 -> 1 runs.
    const out = e.migrate({ name: "no-version" }, 1);
    expect(out.version).toBe(1);
  });

  test("downgrade throws when the needed step is not registered", () => {
    const e = new MigrationEngine();
    // Walking down from 1 to 0 needs the 0→1 step's down(); none registered.
    expect(() => e.migrate({ version: 1 }, 0)).toThrow(MigrationError);
  });

  test("MigrationError carries the config code and an optional cause", () => {
    const cause = new Error("root");
    const err = new MigrationError("boom", cause);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.name).toBe("MigrationError");
    expect(err.cause).toBe(cause);
  });
});

describe("latestVersion (#43 — the current spec-schema version)", () => {
  test("empty engine → 0 (nothing to upgrade to)", () => {
    expect(new MigrationEngine().latestVersion()).toBe(0);
  });

  test("the default engine's latest is 1 (the NOOP 0→1 step)", () => {
    expect(createDefaultEngine().latestVersion()).toBe(1);
  });

  test("is the max `to` across registered migrations", () => {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1 }),
    });
    expect(e.latestVersion()).toBe(2);
  });
});
