/**
 * Phase 3 §3.3 — the cli-target banner, owned in ONE place for BOTH cli
 * surfaces.
 *
 * `cli.banner` used to be codegen-only: `emitCli` inlined a
 * `process.stdout.write(...)` into the bundle, and the interpreter path
 * (`crewhaus run`) never read `ir.cli` at all. A spec-authored banner was
 * therefore invisible to everyone who ran the spec directly instead of
 * compiling it — and the spec block's own documentation ("suppressed under
 * `--resume` / `--continue` so resumed sessions don't re-banner") described
 * flags that only exist on the interpreter path, which never printed a
 * banner to suppress.
 *
 * This module holds the whole contract:
 *
 *   - {@link pickTagline} / {@link formatBanner} / {@link renderBanner} — the
 *     rendering, used directly by `crewhaus run`.
 *   - {@link shouldPrintBanner} — the pure suppression gate: a resumed run
 *     (`--resume` / `--continue`, or `CREWHAUS_RESUMED=1` for an external
 *     wrapper re-invoking a compiled bundle) skips the banner.
 *   - {@link renderBannerBoot} — the codegen snippet `emitCli` inlines, which
 *     recomputes exactly what {@link renderBanner} returns. The two are pinned
 *     together by a parity test that evaluates the emitted snippet.
 *
 * Deliberately dependency-free (types only) so the interpreter can import it
 * without dragging codegen machinery into a run, and so the emitted snippet
 * stays self-contained — a compiled bundle must not take a runtime dependency
 * on an emitter package.
 */
import type { IrCliBanner } from "@crewhaus/ir";

/**
 * Set by an external wrapper that re-invokes a COMPILED bundle for a resumed
 * session (a compiled bundle parses no flags of its own). On the interpreter
 * path `--resume` / `--continue` suppress the banner directly; this env is
 * honoured there too so both surfaces answer to the same switch.
 */
export const RESUMED_ENV = "CREWHAUS_RESUMED";

/**
 * The tagline for one startup. `static` always picks the first (the IR
 * guarantees ≥ 1 tagline); `random` picks uniformly, once per process.
 * `random` is injectable so the codegen-parity test can pin the draw.
 */
export function pickTagline(banner: IrCliBanner, random: () => number = Math.random): string {
  if (banner.taglineMode === "random") {
    return banner.taglines[Math.floor(random() * banner.taglines.length)] as string;
  }
  return banner.taglines[0] as string;
}

/** The exact bytes a banner writes: a blank line, the bold spec name, an
 *  em-dash, the tagline, and a trailing blank line. */
export function formatBanner(name: string, tagline: string): string {
  return `\n\x1b[1m${name}\x1b[0m — ${tagline}\n\n`;
}

/** The full banner for one startup (tagline draw + formatting). */
export function renderBanner(
  name: string,
  banner: IrCliBanner,
  random: () => number = Math.random,
): string {
  return formatBanner(name, pickTagline(banner, random));
}

/**
 * The suppression gate. Prints only when the spec declared a banner AND this
 * is a cold start: a resumed session (interpreter `--resume` / `--continue`,
 * or `CREWHAUS_RESUMED=1`) never re-banners.
 */
export function shouldPrintBanner(opts: {
  readonly banner: IrCliBanner | undefined;
  readonly resumed: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (opts.banner === undefined) return false;
  if (opts.resumed) return false;
  return opts.env[RESUMED_ENV] !== "1";
}

/**
 * Escape a spec name for the backtick template literal the emitted snippet
 * writes it into. Codegen-only: the interpreter passes the raw name to
 * {@link renderBanner}, and the parity test proves both produce identical
 * bytes for hostile names.
 */
function escapeBannerName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * The codegen snippet `emitCli` inlines ahead of `runChatLoop`, so a compiled
 * bundle shows the brand on cold start. Returns "" when the spec declared no
 * banner, keeping bannerless bundles byte-identical.
 */
export function renderBannerBoot(name: string, banner: IrCliBanner | undefined): string {
  if (banner === undefined) return "";
  return `if (process.env.${RESUMED_ENV} !== "1") {
  const __taglines = ${JSON.stringify(banner.taglines)};
  const __tagline = ${
    banner.taglineMode === "random"
      ? "__taglines[Math.floor(Math.random() * __taglines.length)]"
      : "__taglines[0]"
  };
  process.stdout.write(\`\\n\\x1b[1m${escapeBannerName(name)}\\x1b[0m — \${__tagline}\\n\\n\`);
}
`;
}
