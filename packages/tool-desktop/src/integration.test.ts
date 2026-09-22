/**
 * The ONE test in this package allowed near the real host, and it still
 * spawns nothing.
 *
 * House rule 4 caps this file at a single real-host test asserting shape
 * only. What it is here to prove is the thing the rest of the suite cannot:
 * that the hostile default in `../host.ts` is a TEST-ONLY condition. Every
 * other test drives seams, so all of them would keep passing if
 * `hostPlatform()` had been wired to answer `"unsupported"` unconditionally —
 * and the package would then refuse on every real desktop in the world while
 * its suite stayed green. That failure is invisible from inside the seams,
 * which is exactly why it gets a test of its own.
 *
 * It has NO side effects. `dryRun` resolves the plan and stops before the
 * effect, so nothing is opened, nothing is printed, no toast appears, no
 * clipboard is read into this transcript and no inhibitor is held. The real
 * host is consulted for two facts only: which platform this is, and what the
 * session environment looks like.
 */
import { afterEach, expect, test } from "bun:test";
import { _resetHostSeams, hostPlatform, realHostPlatform, sessionEnv } from "./host";
import { openExternal } from "./index";
import { _allowRealHost, _resetRunSeams } from "./run";

afterEach(() => {
  _resetHostSeams();
  _resetRunSeams();
});

test("with the gate open and no seams, the package sees the real machine", async () => {
  // Under `bun test` the gate is shut, so an un-injected seam answers
  // "unsupported" on every machine identically.
  expect(hostPlatform()).toBe("unsupported");

  _allowRealHost(true);
  try {
    const real = realHostPlatform();
    const seen = hostPlatform();
    const env = sessionEnv();
    console.log(
      `REAL platform=${real} seen=${seen} display=${env.DISPLAY ?? "(unset)"} ssh=${env.SSH_CONNECTION !== undefined}`,
    );
    // Production does NOT get the hostile default: with the gate open and no
    // runner installed, the package reads the machine it is actually on.
    expect(seen).toBe(real);
    expect(["darwin", "linux", "win32", "unsupported"]).toContain(seen);

    // A dryRun on the real platform: it resolves a plan, or it says why it
    // cannot. Shape only — the concrete argv belongs to index.test.ts, which
    // pins each platform explicitly instead of inheriting this one.
    const out = JSON.parse(
      String(await openExternal.execute({ target: "https://example.com", dryRun: true } as never)),
    ) as Record<string, unknown>;
    console.log(`REAL_DRYRUN ${JSON.stringify(out)}`);
    expect(out["tool"]).toBe("OpenExternal");
    expect(out["platform"]).toBe(real);
    expect(["dryRun", "unavailable"]).toContain(out["outcome"]);
    if (out["outcome"] === "dryRun") {
      const plan = out["plan"] as Record<string, unknown>;
      expect(Array.isArray(plan["argv"])).toBe(true);
      // Whatever the platform, the target is an argv ELEMENT or an
      // environment value, never spliced into a command line.
      expect((plan["argv"] as string[]).join(" ")).not.toMatch(/&&|\|\||;/);
    } else {
      // A headless CI box: a named reason, not a crash and not a pretend plan.
      expect(String(out["reason"]).length).toBeGreaterThan(0);
    }
  } finally {
    // Restored in the same `finally` as it was opened, so no later test in
    // this process inherits an open gate.
    _allowRealHost(false);
  }

  expect(hostPlatform()).toBe("unsupported");
});
