/**
 * Every CLI head that wires the control plane passes the same `authorizeActor` Home
 * passes, so a command the CLI dispatches from its receipt is checked as Home checks it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;

/** Each `wireControl(` call in `text`, and whether its deps name `authorizeActor`. */
function wireCalls(text: string): { readonly at: number; readonly checked: boolean }[] {
  const calls: { at: number; checked: boolean }[] = [];
  for (
    let at = text.indexOf("wireControl(");
    at !== -1;
    at = text.indexOf("wireControl(", at + 1)
  ) {
    const options = text.indexOf("{ mode:", at);
    const deps = text.slice(at, options === -1 ? undefined : options);
    calls.push({ at, checked: /\bauthorizeActor\s*:/.test(deps) });
  }
  return calls;
}

/** Every non-test source file under `apps/cli/src`, relative. */
function sources(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

describe("every CLI head checks a recovered command's actor", () => {
  test("every wireControl call under apps/cli/src passes authorizeActor", () => {
    const found: string[] = [];
    for (const name of sources()) {
      const text = readFileSync(join(SRC, name), "utf8");
      for (const call of wireCalls(text)) found.push(`${name} ${call.checked}`);
    }
    expect(found).toEqual([
      "daemon-cmd.ts true",
      "deploy-activate-cmd.ts true",
      "hangar-cmd.ts true",
      "people-cmd.ts true",
      "quality-receipts.ts true",
    ]);
  });

  test("the scanner finds a call that passes no authorizeActor", () => {
    const planted = [
      "const control = wireControl(",
      "  { hangarRoot, identity, probe, supervisorFor, drainRequest },",
      '  { mode: "direct" },',
      ");",
      "const checked = wireControl(",
      "  { hangarRoot, authorizeActor: cliAuthorizeActor({ hangarRoot }) },",
      '  { mode: "direct" },',
      ");",
    ].join("\n");
    expect(wireCalls(planted).map((call) => call.checked)).toEqual([false, true]);
  });
});
