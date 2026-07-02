import type { VerifyResult } from "@crewhaus/audit-log";

/**
 * Item 34 — `crewhaus audit verify` plumbing, factored out of the entry file
 * `index.ts` (which runs a top-level argv switch and so cannot be imported by
 * a test without executing the CLI). Side-effect-free and directly
 * unit-testable, mirroring `scope-audit.ts` / `justification-gate.ts` /
 * `doctor-checks.ts`.
 *
 * Two halves:
 *   1. `resolveAnchorFlag` — parse the `--anchor <scheme>:<path>` flag. Only
 *      `file:` ships today (`@crewhaus/audit-log`'s `FileAnchorStore`); an
 *      unknown scheme throws so the entry file can `die()` with the allowed
 *      list instead of silently skipping the cross-check the user asked for.
 *   2. `summarizeVerifyResult` — turn the library's `VerifyResult` into the
 *      per-check ✓/~/✗ summary lines + exit code. The exit-code contract:
 *      0 only when the chain is intact AND (when an anchor store was
 *      explicitly requested) the external anchor was actually cross-checked —
 *      a requested-but-unconsulted anchor exits 1, because a scheduled
 *      tamper check that silently skipped its strongest witness is worse
 *      than one that fails loudly.
 */

export type AnchorFlagChoice = { readonly scheme: "file"; readonly path: string };

const VALID_ANCHOR_SCHEMES = ["file"] as const;

/** Thrown by `resolveAnchorFlag` on a malformed `--anchor` value. The CLI
 *  entry file catches it and routes the message through `die()`; tests
 *  assert on `.message` without the process exiting. */
export class InvalidAnchorFlagError extends Error {
  override readonly name = "InvalidAnchorFlagError";
  constructor(readonly value: string) {
    super(
      `invalid --anchor "${value}" — expected <scheme>:<path> with scheme one of: ${VALID_ANCHOR_SCHEMES.join(", ")} (e.g. file:/var/crewhaus/anchors)`,
    );
  }
}

/**
 * Parse the raw `--anchor` flag value (or undefined when absent). `file:<path>`
 * selects the file-backed AnchorStore rooted at `<path>`; anything else —
 * missing scheme, empty path, unknown scheme (S3 et al. are out of scope) —
 * throws {@link InvalidAnchorFlagError}.
 */
export function resolveAnchorFlag(flagValue: string | undefined): AnchorFlagChoice | undefined {
  if (flagValue === undefined) return undefined;
  const sep = flagValue.indexOf(":");
  if (sep <= 0) throw new InvalidAnchorFlagError(flagValue);
  const scheme = flagValue.slice(0, sep);
  const path = flagValue.slice(sep + 1);
  if (scheme !== "file" || path === "") throw new InvalidAnchorFlagError(flagValue);
  return { scheme, path };
}

export type VerifySummary = {
  readonly lines: ReadonlyArray<string>;
  readonly exitCode: 0 | 1;
};

/**
 * Render a `VerifyResult` as per-check summary lines + the process exit code.
 * `anchorRequested` is whether the user passed `--anchor`: when true, an
 * `ok` result whose external anchor was NOT actually consulted (store empty,
 * unreadable, or lagging into nonexistence) is a FAILURE — the check the
 * user scheduled did not run, so exiting 0 would fabricate assurance.
 */
export function summarizeVerifyResult(
  result: VerifyResult,
  opts: { readonly anchorRequested: boolean },
): VerifySummary {
  if (!result.ok) {
    return {
      exitCode: 1,
      lines: [
        `✗ tamper finding at ${result.file}:${result.line} — ${result.reason}`,
        `  ${result.recordsChecked} record(s) verified cleanly before the finding`,
      ],
    };
  }
  const lines: string[] = [
    `✓ hash chain intact — ${result.recordsChecked} record(s) checked (per-record hash, prevHash links, gapless seq from 0)`,
  ];
  if (result.anchorChecked) {
    lines.push("✓ on-host chain-tail anchor matches the surviving tail");
  } else {
    lines.push(
      "~ on-host chain-tail anchor absent — tail truncation cannot be ruled out (limitation, not tamper)",
    );
  }
  let exitCode: 0 | 1 = 0;
  if (result.externalAnchorChecked) {
    lines.push("✓ external anchor store agrees with the chain tip");
  } else if (opts.anchorRequested) {
    exitCode = 1;
    lines.push(
      "✗ external anchor requested (--anchor) but could not be cross-checked — the store holds no anchor for this log (or is unreadable), so the strongest tamper witness did not run",
    );
  } else {
    lines.push("~ external anchor not consulted (pass --anchor file:<path> to cross-check one)");
  }
  return { lines, exitCode };
}

/** Shape shared with `index.ts`'s DoctorCheck (label/pass/warn/reason). */
export type AuditIntegrityCheck = {
  readonly label: string;
  readonly pass: boolean;
  readonly warn?: boolean;
  readonly reason?: string;
};

/**
 * Map a `VerifyResult` onto the doctor's ✓/~/✗ check shape so `crewhaus
 * doctor` can surface audit-log tampering when a `.crewhaus/audit` store
 * exists in the cwd. An intact chain without the on-host anchor is a warn
 * ("~"), never a failure — mirroring the library's limitation-not-tamper
 * stance — and a broken chain fails doctor with the first finding inline.
 */
export function buildAuditIntegrityCheck(result: VerifyResult): AuditIntegrityCheck {
  if (!result.ok) {
    return {
      label: "Audit log integrity (.crewhaus/audit)",
      pass: false,
      reason: `${result.reason} (${result.file}:${result.line}) — run \`crewhaus audit verify\` for details`,
    };
  }
  if (!result.anchorChecked) {
    return {
      label: `Audit log integrity (.crewhaus/audit, ${result.recordsChecked} records)`,
      pass: true,
      warn: true,
      reason:
        "chain intact but the chain-tail anchor is absent — tail truncation cannot be ruled out",
    };
  }
  return {
    label: `Audit log integrity (.crewhaus/audit, ${result.recordsChecked} records)`,
    pass: true,
  };
}
