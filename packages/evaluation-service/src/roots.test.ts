import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { proofsRoot } from "@crewhaus/provability";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import { tempDirs } from "./__fixtures__/helpers";
import { activeTenant, fencedDir, gateProofsRoot, gateSessionRoot, proofsDirName } from "./roots";

const dirs = tempDirs();
const savedEnv = process.env["CREWHAUS_SESSION_DIR"];
afterEach(() => {
  dirs.cleanup();
  if (savedEnv === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
  else process.env["CREWHAUS_SESSION_DIR"] = savedEnv;
});

describe("outside a tenant", () => {
  test("the proofs root is provability's, under the workspace", () => {
    const cwd = dirs.make();
    expect(activeTenant()).toBeUndefined();
    expect(gateProofsRoot(cwd, "bot", undefined)).toBe(proofsRoot(cwd, "bot"));
  });

  test("the session root: the caller's, else CREWHAUS_SESSION_DIR, else event-log's default (undefined)", () => {
    Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
    expect(gateSessionRoot(undefined, undefined)).toBeUndefined();
    process.env["CREWHAUS_SESSION_DIR"] = "/srv/sessions";
    expect(gateSessionRoot(undefined, undefined)).toBe("/srv/sessions");
    expect(gateSessionRoot("rel/logs", undefined)).toBe(resolve("rel/logs"));
  });
});

describe("proofsDirName", () => {
  test("a name the proofs store accepts is its own directory, unchanged", () => {
    for (const name of ["bot", "support-bot", "a.b_c-1", ".hidden"]) {
      expect(proofsDirName(name)).toBe(name);
    }
  });

  test("a name the spec schema admits but the store refuses maps to a safe, stable, distinct directory", () => {
    const spaced = proofsDirName("support bot");
    expect(spaced).toMatch(/^support_bot-[0-9a-f]{12}$/);
    expect(proofsDirName("support bot")).toBe(spaced);
    expect(proofsDirName("team:support")).toMatch(/^team_support-[0-9a-f]{12}$/);
    // Never the directory of the spec literally named with the safe characters.
    expect(spaced).not.toBe(proofsDirName("support_bot"));
    expect(proofsDirName("support  bot")).not.toBe(spaced);
    // Dots only would be `.` / `..` as a path segment.
    expect(proofsDirName("..")).toMatch(/^spec-[0-9a-f]{12}$/);
    expect(proofsDirName("")).toMatch(/^spec-[0-9a-f]{12}$/);
    // Every mapped name is one the store files under.
    for (const name of ["support bot", "team:support", "..", " : "]) {
      const cwd = dirs.make();
      expect(gateProofsRoot(cwd, name, undefined)).toBe(proofsRoot(cwd, proofsDirName(name)));
    }
  });
});

describe("inside a tenant", () => {
  test("roots move under the tenant's own root", async () => {
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    await withTenant(acme, () => {
      const tenant = activeTenant();
      expect(tenant?.id).toBe("acme");
      expect(gateProofsRoot("/workspace", "bot", tenant)).toBe(
        resolve(acme.sessionRoot, "..", "proofs", "bot"),
      );
      expect(gateProofsRoot("/workspace", "support bot", tenant)).toBe(
        resolve(acme.sessionRoot, "..", "proofs", proofsDirName("support bot")),
      );
      expect(gateSessionRoot(undefined, tenant)).toBe(resolve(acme.sessionRoot));
    });
  });

  test("a root outside the tenant's fails closed", () => {
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    expect(() => fencedDir(join(tenants, "globex", "sessions"), acme)).toThrow(TenancyError);
    expect(() => gateSessionRoot("/elsewhere", acme)).toThrow(TenancyError);
    expect(fencedDir(join(acme.sessionRoot, "x"), acme)).toBe(resolve(acme.sessionRoot, "x"));
  });
});
