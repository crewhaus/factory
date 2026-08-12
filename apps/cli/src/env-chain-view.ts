/**
 * ONE rendering of "which env files does this harness read", shared by
 * `crewhaus daemon status` and `crewhaus harness show`.
 *
 * The chain only became worth printing when it stopped being obvious: a
 * fleet that keeps its credentials in a shared `../.env` (declared under
 * `manager.envFiles` in `.crewhaus/settings.json`) resolves keys from a file
 * that is nowhere near the harness, and until something names it the only
 * way to find out was to read the daemon's environment. Shared entries are
 * printed with the path they RESOLVED to — a relative declaration means
 * nothing without the root it resolved against — and a declared file that
 * is not there is printed as an absence rather than omitted.
 *
 * Never prints a VALUE. The chain is a list of files; the keys inside them
 * are the credentials panel's business, and this view is rendered in places
 * (a screen-shared console, a piped `status`) where a value must not appear.
 */
import type { EnvFileRef } from "@crewhaus/harness-supervisor";

/**
 * Indented lines describing the chain, lowest precedence first. Empty when
 * the harness has no env files at all — a harness whose keys all come from
 * `process.env` should not grow a section that says nothing.
 */
export function envChainLines(refs: readonly EnvFileRef[], indent = "  "): string[] {
  if (refs.length === 0) return [];
  const lines = [`${indent}env files (lowest precedence first, all UNDER process.env):`];
  for (const ref of refs) {
    if (ref.scope === "harness") {
      lines.push(`${indent}  ${ref.declaredAs}`);
      continue;
    }
    lines.push(
      ref.present
        ? `${indent}  ${ref.declaredAs} → ${ref.path}  [shared]`
        : `${indent}  ${ref.declaredAs} → ${ref.path}  [shared, MISSING — nothing is read from it]`,
    );
  }
  return lines;
}
