/**
 * HM-188 — the win32 supervision notice.
 *
 * The process layer's Windows adapter (`createWindowsProcessOps`: PowerShell
 * `Get-Process` for liveness and start time, `taskkill /T` for the tree)
 * shipped with the process layer, but until the `windows-supervision` job in
 * `.github/workflows/ci.yml` reports green it has never EXECUTED on Windows —
 * its output parsers are unit-tested against captured strings, which is not
 * the same claim.
 *
 * The exposure is specific and worth naming out loud: liveness is
 * `pid + OS start-time + argv`, and a WRONG liveness verdict is the failure
 * with real consequences — it is what lets a restart spawn a second copy of
 * a channel daemon, which means double message processing and double
 * provider spend. Windows binaries ship through Scoop and winget, so there
 * are real users to be honest with; "written but unrun" is not a claim worth
 * making silently.
 *
 * REMOVING THIS: when the Windows CI job is green and gating, delete this
 * module, its two call sites (`crewhaus hangar` and `crewhaus daemon`), and
 * this test file. The notice is a statement about CI, not about Windows —
 * it comes off the moment CI can make the statement instead.
 */

/** The one line the manager prints on win32. Deliberately says what could go
 *  wrong and what to do about it, rather than a bare "unsupported". */
export const WINDOWS_SUPERVISION_NOTICE =
  "note: process supervision on Windows is UNVERIFIED — the Windows process adapter " +
  "(Get-Process liveness, taskkill) has no green CI run yet, so a wrong liveness verdict " +
  "could start a second copy of a running daemon. Confirm with `crewhaus daemon status` " +
  "before start/restart.";

/**
 * The notice for `platform`, or `undefined` where supervision is verified.
 *
 * The platform is injected (defaulting to the real one) so the message is
 * testable from any machine — the notice's whole purpose is to describe a
 * platform the test run is not on.
 */
export function windowsSupervisionNotice(platform: string = process.platform): string | undefined {
  return platform === "win32" ? WINDOWS_SUPERVISION_NOTICE : undefined;
}
