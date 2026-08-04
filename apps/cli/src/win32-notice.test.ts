/**
 * HM-188 — the win32 supervision notice. Delete alongside the module when
 * the `windows-supervision` CI job is green and gating.
 */
import { describe, expect, test } from "bun:test";
import { WINDOWS_SUPERVISION_NOTICE, windowsSupervisionNotice } from "./win32-notice";

describe("windowsSupervisionNotice", () => {
  test("win32 gets the notice; every other platform gets nothing", () => {
    expect(windowsSupervisionNotice("win32")).toBe(WINDOWS_SUPERVISION_NOTICE);
    for (const platform of ["darwin", "linux", "freebsd", "openbsd", "sunos", "aix"]) {
      expect(windowsSupervisionNotice(platform)).toBeUndefined();
    }
  });

  test("it is ONE line and names the risk plus the check to run", () => {
    // A notice that only says "unsupported" teaches an operator nothing; the
    // duplicate-daemon failure and its cheap check are the payload.
    expect(WINDOWS_SUPERVISION_NOTICE.split("\n")).toHaveLength(1);
    expect(WINDOWS_SUPERVISION_NOTICE).toContain("UNVERIFIED");
    expect(WINDOWS_SUPERVISION_NOTICE).toContain("second copy");
    expect(WINDOWS_SUPERVISION_NOTICE).toContain("crewhaus daemon status");
  });
});
