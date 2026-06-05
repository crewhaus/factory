/**
 * Section 27 — `env-var` backend coverage.
 *
 * Targets the rotate() warning + missing-value paths and list().
 * No real `process.env` is touched: every test passes an explicit `env`
 * object, and the logger is a plain in-memory spy (no real clock, no
 * stderr writes, no leaked handles).
 */
import { describe, expect, test } from "bun:test";
import type { LogFields } from "@crewhaus/logging";
import { createEnvVarBackend } from "../backends/env-var";
import { SecretsError } from "../index";

type WarnCall = { msg: string; fields?: LogFields };

/** Minimal Logger spy — records warn() calls, ignores the rest. */
function makeLogger() {
  const warns: WarnCall[] = [];
  const logger = {
    debug() {},
    info() {},
    warn(msg: string, fields?: LogFields) {
      warns.push({ msg, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

describe("env-var backend — id", () => {
  test("exposes the env-var id", () => {
    const backend = createEnvVarBackend({ env: {} as NodeJS.ProcessEnv });
    expect(backend.id).toBe("env-var");
  });

  test("defaults env to process.env when not supplied", () => {
    // Construct without an `env` option to exercise the `?? process.env`
    // fallback branch. We never read or mutate a real secret here — just
    // assert the backend is constructed against the default env.
    const backend = createEnvVarBackend();
    expect(backend.id).toBe("env-var");
  });
});

describe("env-var backend — rotate() warning + return paths", () => {
  test("rotate(newValue) logs the no-op warning and returns the new value", async () => {
    const { logger, warns } = makeLogger();
    const env: NodeJS.ProcessEnv = { TOKEN: "old" };
    const backend = createEnvVarBackend({ env, logger });

    const v = await backend.rotate("TOKEN", { newValue: "new" });

    expect(v).toBe("new");
    expect(env["TOKEN"]).toBe("new");
    expect(warns.length).toBe(1);
    expect(warns[0]?.msg).toBe("secrets.rotate.env-var.no-op");
    expect((warns[0]?.fields as { name: string }).name).toBe("TOKEN");
  });

  test("rotate without newValue returns the pre-existing env value (logs warning)", async () => {
    const { logger, warns } = makeLogger();
    const env: NodeJS.ProcessEnv = { TOKEN: "already-set" };
    const backend = createEnvVarBackend({ env, logger });

    const v = await backend.rotate("TOKEN");

    expect(v).toBe("already-set");
    // value must be untouched when no newValue is provided
    expect(env["TOKEN"]).toBe("already-set");
    expect(warns.length).toBe(1);
  });

  test("rotate without newValue on an unset name throws SecretsError", async () => {
    const { logger, warns } = makeLogger();
    const env: NodeJS.ProcessEnv = {};
    const backend = createEnvVarBackend({ env, logger });

    expect(backend.rotate("NOPE")).rejects.toBeInstanceOf(SecretsError);
    // the warning still fires before the missing-value throw
    await backend.rotate("NOPE").catch(() => {});
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("rotate without a logger still returns the new value (no-warn branch)", async () => {
    const env: NodeJS.ProcessEnv = { TOKEN: "old" };
    const backend = createEnvVarBackend({ env });

    const v = await backend.rotate("TOKEN", { newValue: "fresh" });

    expect(v).toBe("fresh");
    expect(env["TOKEN"]).toBe("fresh");
  });

  test("rotate without a logger and without newValue throws when unset", async () => {
    const env: NodeJS.ProcessEnv = {};
    const backend = createEnvVarBackend({ env });
    expect(backend.rotate("MISSING")).rejects.toBeInstanceOf(SecretsError);
  });
});

describe("env-var backend — list()", () => {
  test("returns only names with non-empty values", async () => {
    const env: NodeJS.ProcessEnv = {
      A: "1",
      B: "2",
      EMPTY: "",
      UNDEF: undefined,
    };
    const backend = createEnvVarBackend({ env });

    const names = await backend.list?.();

    expect(names).toBeDefined();
    expect([...(names ?? [])].sort()).toEqual(["A", "B"]);
  });

  test("returns an empty array when env has no usable entries", async () => {
    const env: NodeJS.ProcessEnv = { EMPTY: "", UNDEF: undefined };
    const backend = createEnvVarBackend({ env });
    expect(await backend.list?.()).toEqual([]);
  });
});
