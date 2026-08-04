/**
 * HM-12 — first-boot onboarding and demo mode.
 *
 * The refusals matter as much as the happy path: demo mode must say what is
 * missing and what to do about it rather than fail, must never overwrite an
 * existing directory, must never follow a symlink out of either tree, and
 * must never install INTO the demos checkout it copied from.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  DEMOS_DIR_ENV,
  StarterInstallError,
  demoAvailability,
  installStarter,
  onboardingView,
  suggestScanRoots,
} from "./onboarding";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

/** A demos-repo-shaped checkout with one starter. */
function makeDemosCheckout(root: string, starter = "cli-quickstart"): string {
  const dir = join(root, "starters", starter);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    "name: cli-quickstart\ntarget: cli\nagent:\n  model: claude-opus-5\n",
  );
  writeFileSync(join(dir, "src", "tool.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  // Present in a real checkout and deliberately NOT copied.
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports=1;\n");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "agent.ts"), "// stale build\n");
  return root;
}

describe("suggestScanRoots", () => {
  test("suggests the conventional home and the launch directory, each with a reason", () => {
    const home = resolve(sep, "home", "op");
    const work = join(home, "work");
    const suggestions = suggestScanRoots({}, home, work, () => true);
    // Built with `join`, not literals: the impl joins, so a literal POSIX
    // expectation asserts the platform rather than the behaviour.
    // `suggestScanRoots` resolves every entry, so a rooted-but-driveless
    // path (`\\home\\op`) comes back drive-qualified on Windows. Resolve the
    // expectation the same way rather than asserting a platform.
    expect(suggestions.map((s) => s.dir)).toEqual([resolve(home, "harnesses"), resolve(work)]);
    for (const s of suggestions) expect(s.why.length).toBeGreaterThan(0);
  });

  test("a configured demos checkout and harness root are offered too, de-duplicated", () => {
    const suggestions = suggestScanRoots(
      {
        [DEMOS_DIR_ENV]: resolve(sep, "opt", "demos"),
        CREWHAUS_HARNESS_ROOT: resolve(sep, "home", "op", "harnesses"),
      },
      resolve(sep, "home", "op"),
      resolve(sep, "home", "op"),
      () => false,
    );
    const dirs = suggestions.map((s) => s.dir);
    expect(dirs).toContain(resolve(sep, "opt", "demos", "starters"));
    // `~/harnesses` was already suggested; CREWHAUS_HARNESS_ROOT must not
    // add it a second time.
    expect(dirs.filter((d) => d === resolve(sep, "home", "op", "harnesses"))).toHaveLength(1);
    expect(suggestions.every((s) => !s.exists)).toBe(true);
  });

  test("relative paths are never suggested", () => {
    const suggestions = suggestScanRoots({ CREWHAUS_HARNESS_ROOT: "./here" }, "/home/op", "/x");
    expect(suggestions.some((s) => s.dir.includes("./here"))).toBe(false);
  });
});

describe("demoAvailability", () => {
  test("no checkout ⇒ unavailable, with the repo, the variable and the CLI verb named", () => {
    const answer = demoAvailability({});
    expect(answer.available).toBe(false);
    expect(answer.reason).toContain(DEMOS_DIR_ENV);
    expect(answer.remedy).toContain("github.com/crewhaus/demos");
    expect(answer.remedy).toContain("crewhaus init");
  });

  test("a directory that is not a demos checkout is refused by name", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-nodemos-"));
    try {
      const answer = demoAvailability({}, root);
      expect(answer.available).toBe(false);
      expect(answer.reason).toContain("no starters/ directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a real checkout lists only starters that actually carry a spec", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-demos-"));
    try {
      makeDemosCheckout(root);
      mkdirSync(join(root, "starters", "not-a-starter"), { recursive: true });
      const answer = demoAvailability({ [DEMOS_DIR_ENV]: root });
      expect(answer.available).toBe(true);
      expect(answer.starters).toEqual(["cli-quickstart"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installStarter", () => {
  test("copies the working files, skips build output and dependencies", () => {
    const workspace = mkdtempSync(join(tmpdir(), "hangar-install-"));
    try {
      const demos = makeDemosCheckout(join(workspace, "demos"));
      const dest = join(workspace, "my-first-harness");
      const result = installStarter({ demosDir: demos, starter: "cli-quickstart", destDir: dest });
      expect(result.filesCopied).toBeGreaterThan(0);
      expect(existsSync(join(dest, "crewhaus.yaml"))).toBe(true);
      expect(existsSync(join(dest, "src", "tool.ts"))).toBe(true);
      // A dotfile that is part of the example DOES come along…
      expect(existsSync(join(dest, ".gitignore"))).toBe(true);
      // …and the two directories nobody wants copied do not.
      expect(existsSync(join(dest, "node_modules"))).toBe(false);
      expect(existsSync(join(dest, "dist"))).toBe(false);
      expect(readFileSync(join(dest, "crewhaus.yaml"), "utf8")).toContain("target: cli");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("refuses a non-empty destination rather than merging into it", () => {
    const workspace = mkdtempSync(join(tmpdir(), "hangar-install-"));
    try {
      const demos = makeDemosCheckout(join(workspace, "demos"));
      const dest = join(workspace, "existing");
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "IMPORTANT.md"), "someone's work\n");
      expect(() =>
        installStarter({ demosDir: demos, starter: "cli-quickstart", destDir: dest }),
      ).toThrow(StarterInstallError);
      expect(readFileSync(join(dest, "IMPORTANT.md"), "utf8")).toBe("someone's work\n");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("refuses to install inside the demos checkout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "hangar-install-"));
    try {
      const demos = makeDemosCheckout(join(workspace, "demos"));
      expect(() =>
        installStarter({
          demosDir: demos,
          starter: "cli-quickstart",
          destDir: join(demos, "scratch"),
        }),
      ).toThrow(/inside the demos checkout/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a traversing starter name never leaves the starters directory", () => {
    const workspace = mkdtempSync(join(tmpdir(), "hangar-install-"));
    try {
      const demos = makeDemosCheckout(join(workspace, "demos"));
      for (const bad of ["../..", "..", "a/b", "/etc"]) {
        expect(() =>
          installStarter({
            demosDir: demos,
            starter: bad,
            destDir: join(workspace, `out-${bad.replace(/\W/g, "")}`),
          }),
        ).toThrow(StarterInstallError);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a symlink inside the starter is skipped, not followed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "hangar-install-"));
    try {
      const demos = makeDemosCheckout(join(workspace, "demos"));
      const secretDir = join(workspace, "elsewhere");
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, "private.txt"), "not for the demo\n");
      symlinkSync(
        join(secretDir, "private.txt"),
        join(demos, "starters", "cli-quickstart", "linked.txt"),
      );
      const dest = join(workspace, "out");
      installStarter({ demosDir: demos, starter: "cli-quickstart", destDir: dest });
      expect(existsSync(join(dest, "linked.txt"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("onboardingView", () => {
  test("firstBoot is true only when there is nothing at all, and CLI twins are always present", () => {
    const demo = demoAvailability({});
    const empty = onboardingView({
      harnessCount: 0,
      scanRootCount: 0,
      suggestions: [],
      demo,
      completedAt: null,
    });
    expect(empty.firstBoot).toBe(true);
    expect(Object.keys(empty.cliTwins).length).toBeGreaterThan(3);
    // The scan-root step's twin is a command the CLI accepts — there is no
    // `harness scan-root` verb, and this is the FIRST screen a new operator
    // copies from. `cli-twins.test.ts` validates the whole set.
    expect(empty.cliTwins["addScanRoot"]).toBe("crewhaus harness scan --root <dir>");

    expect(
      onboardingView({
        harnessCount: 1,
        scanRootCount: 0,
        suggestions: [],
        demo,
        completedAt: null,
      }).firstBoot,
    ).toBe(false);
  });
});

describe("GET /api/onboarding and POST /api/onboarding/demo", () => {
  test("with no demos checkout the demo refuses with a 409 and a remedy", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const view = await t.api("/api/onboarding");
      expect(view.status).toBe(200);
      expect(view.body["firstBoot"]).toBe(true);
      expect((view.body["demo"] as { available: boolean }).available).toBe(false);

      const attempt = await t.api("/api/onboarding/demo", {
        method: "POST",
        body: JSON.stringify({ starter: "cli-quickstart", dir: join(t.workspace, "demo") }),
      });
      expect(attempt.status).toBe(409);
      expect(attempt.body["reason"]).toBe("no-demos-checkout");
      expect(String(attempt.body["remedy"])).toContain("crewhaus/demos");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("with a checkout, the demo installs, registers and appears in the Library", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hangar-demo-"));
    const demos = makeDemosCheckout(join(scratch, "demos"));
    const t = bootTestServer({ now: () => NOW, demosDir: demos });
    try {
      const view = await t.api("/api/onboarding");
      expect((view.body["demo"] as { starters: string[] }).starters).toEqual(["cli-quickstart"]);

      const dest = join(t.workspace, "demo-harness");
      const installed = await t.api("/api/onboarding/demo", {
        method: "POST",
        body: JSON.stringify({ starter: "cli-quickstart", dir: dest }),
      });
      expect(installed.status).toBe(201);
      const entry = installed.body["entry"] as { id: string; dir: string; specName: string };
      expect(entry.dir).toBe(dest);
      expect(entry.specName).toBe("cli-quickstart");

      const rows = (await t.api("/api/harnesses")).body["harnesses"] as Array<{ dir: string }>;
      expect(rows.some((r) => r.dir === dest)).toBe(true);
      // Onboarding is now marked complete, so the console stops leading with it.
      expect((await t.api("/api/onboarding")).body["completedAt"]).not.toBeNull();

      // A second install into the same directory refuses rather than merging.
      const again = await t.api("/api/onboarding/demo", {
        method: "POST",
        body: JSON.stringify({ starter: "cli-quickstart", dir: dest }),
      });
      expect(again.status).toBe(409);
      expect(again.body["reason"]).toBe("refused");
    } finally {
      await t.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
