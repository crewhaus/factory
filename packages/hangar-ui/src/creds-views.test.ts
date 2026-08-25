/**
 * The creds / channels / security console modules, checked where a browser
 * is not needed: their exports, and — the part the server-side contract test
 * structurally cannot see — that every route in those three groups is
 * actually REACHED by a screen.
 *
 * `contract.test.ts` proves the server answers each route; `api.test.ts`
 * proves each wrapper issues the right request. Neither notices a route that
 * no view ever calls, which is how a console ends up with a working endpoint
 * nobody can get to. This closes that gap for this area.
 *
 * DOM behaviour is covered by the server-side suite's payload assertions
 * plus `embed-suite.ts`'s embed scans (no markup-string assignment, valid
 * syntax, closed import graph) — this file adds no headless-DOM machinery to
 * a package that deliberately has none.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { ROUTES, routeKeysInGroup } from "../assets/js/routes.js";

const VIEWS_DIR = join(import.meta.dir, "..", "assets", "js", "views");

const AREA_VIEWS = ["creds.js", "channels.js", "security.js"] as const;

function viewSource(name: string): string {
  return readFileSync(join(VIEWS_DIR, name), "utf8");
}

/** Every `api.<key>(` call site across this area's three modules. */
function calledRouteKeys(): Set<string> {
  const keys = new Set<string>();
  for (const name of AREA_VIEWS) {
    for (const match of viewSource(name).matchAll(/\bapi\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)) {
      const key = match[1];
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
}

describe("creds/channels/security views", () => {
  test("each module exports the render entry the shell dispatches to", () => {
    expect(viewSource("creds.js")).toContain("export async function renderCreds");
    expect(viewSource("creds.js")).toContain("export async function renderCredentialsMatrix");
    expect(viewSource("channels.js")).toContain("export async function renderChannels");
    expect(viewSource("security.js")).toContain("export async function renderSecurity");
  });

  test("every route this area owns is reached by a screen", () => {
    // `secretsRotate` is the deliberate exception, and the console says so on
    // screen: rotation needs a writer this build does not have, and the CLI
    // fallback would put the value in argv. A disabled button WITH the reason
    // beats a button wired to a route that cannot be built honestly.
    const exempt = new Set(["secretsRotate"]);
    const called = calledRouteKeys();
    const unreached: string[] = [];
    for (const group of ["creds", "channels", "security"]) {
      for (const key of routeKeysInGroup(group) as string[]) {
        if (exempt.has(key) || called.has(key)) continue;
        unreached.push(key);
      }
    }
    expect(unreached).toEqual([]);
  });

  test("no view calls a wrapper the route map does not define", () => {
    const unknown = [...calledRouteKeys()].filter((key) => ROUTES[key] === undefined);
    expect(unknown).toEqual([]);
  });

  test("the value inputs are password fields that are never re-populated", () => {
    const creds = viewSource("creds.js");
    // A value goes IN and is cleared; nothing ever writes a server value back
    // into an input, because no server response carries one.
    expect(creds).toContain('type: "password"');
    expect(creds).toContain('input.value = "";');
    expect(creds).toContain('valueInput.value = "";');
  });

  test("the tier-2 refusals are rendered from the SERVER's reason, not invented here", () => {
    const channels = viewSource("channels.js");
    // The console must not carry its own copy of "why Discord cannot be
    // tested" — two copies of a security rationale is one too many, and the
    // server's is the one the refusal is actually computed from.
    expect(channels).toContain("tier2.reason");
    expect(channels).not.toContain('Ed25519"');
    expect(channels).toContain("tier2.available");
  });

  test("the destructive verbs unlock the real run only after a plan", () => {
    const security = viewSource("security.js");
    // The real-run button ships disabled and is enabled by the dry-run
    // handler — the plan is the thing the operator is consenting to.
    expect(security).toContain("disabled: true");
    expect(security).toContain("real.disabled = false");
    expect(security).toContain("confirmName");
  });

  test("audit verify renders its limitations rather than swallowing them", () => {
    expect(viewSource("security.js")).toContain("limitations");
  });
});
