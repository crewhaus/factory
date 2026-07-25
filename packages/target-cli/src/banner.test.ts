import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrCliBanner } from "@crewhaus/ir";
import {
  RESUMED_ENV,
  formatBanner,
  pickTagline,
  renderBanner,
  renderBannerBoot,
  shouldPrintBanner,
} from "./banner";

const workDir = mkdtempSync(join(tmpdir(), "crewhaus-banner-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let fileSeq = 0;

/**
 * Run the emitted codegen snippet the way a COMPILED BUNDLE runs it: write it
 * to a file and execute it with the same Bun that runs the bundle, capturing
 * stdout. `random` is pinned by overriding `Math.random` ahead of the snippet,
 * so a rotating banner's draw is deterministic on both surfaces.
 */
function runBannerBoot(
  code: string,
  opts: { env?: Record<string, string>; random?: number } = {},
): string {
  const file = join(workDir, `boot-${fileSeq++}.ts`);
  const preamble = opts.random === undefined ? "" : `Math.random = () => ${opts.random};\n`;
  writeFileSync(file, preamble + code);
  const proc = Bun.spawnSync([process.execPath, file], {
    env: { PATH: process.env["PATH"] ?? "", ...(opts.env ?? {}) },
  });
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) throw new Error(`banner snippet failed: ${stderr}`);
  return proc.stdout.toString();
}

describe("banner — rendering", () => {
  test("static mode always picks the first tagline", () => {
    const banner: IrCliBanner = { taglineMode: "static", taglines: ["first", "second"] };
    expect(pickTagline(banner, () => 0.99)).toBe("first");
  });

  test("random mode picks by the injected draw", () => {
    const banner: IrCliBanner = { taglineMode: "random", taglines: ["a", "b", "c"] };
    expect(pickTagline(banner, () => 0)).toBe("a");
    expect(pickTagline(banner, () => 0.5)).toBe("b");
    expect(pickTagline(banner, () => 0.99)).toBe("c");
  });

  test("formatBanner writes the bold name, em-dash tagline and surrounding blank lines", () => {
    expect(formatBanner("hello", "be brief")).toBe("\n\x1b[1mhello\x1b[0m — be brief\n\n");
  });
});

describe("banner — suppression gate", () => {
  const banner: IrCliBanner = { taglineMode: "static", taglines: ["t"] };

  test("no banner block → never prints", () => {
    expect(shouldPrintBanner({ banner: undefined, resumed: false, env: {} })).toBe(false);
  });

  test("cold start with a banner block → prints", () => {
    expect(shouldPrintBanner({ banner, resumed: false, env: {} })).toBe(true);
  });

  test("a resumed session (--resume / --continue) does not re-banner", () => {
    expect(shouldPrintBanner({ banner, resumed: true, env: {} })).toBe(false);
  });

  test(`${RESUMED_ENV}=1 suppresses (the compiled-bundle wrapper hook)`, () => {
    expect(shouldPrintBanner({ banner, resumed: false, env: { [RESUMED_ENV]: "1" } })).toBe(false);
  });

  test(`${RESUMED_ENV} set to anything else does not suppress`, () => {
    expect(shouldPrintBanner({ banner, resumed: false, env: { [RESUMED_ENV]: "0" } })).toBe(true);
  });
});

describe("banner — codegen/interpreter parity", () => {
  test("no banner block emits nothing", () => {
    expect(renderBannerBoot("smoke", undefined)).toBe("");
  });

  test("static mode: the emitted snippet writes exactly what renderBanner returns", () => {
    const banner: IrCliBanner = { taglineMode: "static", taglines: ["exhaustive by default", "b"] };
    const emitted = runBannerBoot(renderBannerBoot("hello-procode", banner));
    expect(emitted).toBe(renderBanner("hello-procode", banner));
    expect(emitted).toBe("\n\x1b[1mhello-procode\x1b[0m — exhaustive by default\n\n");
  });

  test("random mode: emitted snippet and renderBanner agree on the same draw", () => {
    const banner: IrCliBanner = { taglineMode: "random", taglines: ["one", "two", "three"] };
    for (const draw of [0, 0.5, 0.99]) {
      const emitted = runBannerBoot(renderBannerBoot("rotator", banner), { random: draw });
      expect(emitted).toBe(renderBanner("rotator", banner, () => draw));
    }
  });

  test("a template-injecting name renders identically on both surfaces (and runs no code)", () => {
    const banner: IrCliBanner = { taglineMode: "static", taglines: ["t"] };
    const name = "evil`${process.exit(1)}";
    const emitted = runBannerBoot(renderBannerBoot(name, banner));
    expect(emitted).toBe(renderBanner(name, banner));
    expect(emitted).toContain("evil`${process.exit(1)}");
  });

  test(`the emitted snippet honours ${RESUMED_ENV}=1 like shouldPrintBanner does`, () => {
    const banner: IrCliBanner = { taglineMode: "static", taglines: ["t"] };
    const code = renderBannerBoot("hello", banner);
    expect(runBannerBoot(code, { env: { [RESUMED_ENV]: "1" } })).toBe("");
    expect(runBannerBoot(code, { env: { [RESUMED_ENV]: "0" } })).toBe(
      renderBanner("hello", banner),
    );
  });
});
