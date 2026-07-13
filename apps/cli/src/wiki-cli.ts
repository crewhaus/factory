/**
 * 0.3.0 memory release (design §3.1/§3.2) — the `crewhaus wiki` verb
 * cluster's pure/IO helpers. Kept thin + separately testable, mirroring
 * `memory-cli.ts` (the entry file runs an argv switch on import, so logic
 * lives here). Read-only verbs only in PR 9 — `clear|restore` ride the
 * continuity trash machinery and `push|pull --thredz` the Thredz PR.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { WikiArticle, WikiRef, WikiStats } from "@crewhaus/wiki-store";

export class WikiCliError extends CrewhausError {
  override readonly name = "WikiCliError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** The wiki root, relative to a harness cwd. */
export const WIKI_SUBDIR = join(".crewhaus", "wiki");

/** Spec names that have a wiki directory under `wikiDir`, sorted. A spec
 *  counts once it has an articles/ dir or an index.json (an empty scaffold
 *  directory is not a wiki yet). */
export function listWikiSpecs(wikiDir: string): string[] {
  if (!existsSync(wikiDir)) return [];
  return readdirSync(wikiDir)
    .filter(
      (d) => existsSync(join(wikiDir, d, "articles")) || existsSync(join(wikiDir, d, "index.json")),
    )
    .sort();
}

/**
 * Resolve which spec's wiki a single-target verb operates on: an explicit
 * `--spec` wins; otherwise a lone wiki is unambiguous; anything else is an
 * error naming the candidates. Mirrors `resolveMemorySpec`.
 */
export function resolveWikiSpec(wikiDir: string, specFlag?: string): string {
  const specs = listWikiSpecs(wikiDir);
  if (specFlag !== undefined) {
    if (!specs.includes(specFlag)) {
      throw new WikiCliError(
        `no wiki for spec "${specFlag}" under ${wikiDir}${
          specs.length > 0 ? ` (have: ${specs.join(", ")})` : ""
        }`,
      );
    }
    return specFlag;
  }
  if (specs.length === 0) {
    throw new WikiCliError(`no wikis under ${wikiDir}`);
  }
  if (specs.length === 1) return specs[0] as string;
  throw new WikiCliError(
    `multiple wikis under ${wikiDir} — pick one with --spec <name> (have: ${specs.join(", ")})`,
  );
}

/** Compact human age: "3m", "7h", "12d". Injectable clock for tests. */
export function humanAge(updatedAtIso: string, nowMs: number): string {
  const updated = Date.parse(updatedAtIso);
  if (Number.isNaN(updated)) return "?";
  const deltaMs = Math.max(0, nowMs - updated);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const TITLE_PREVIEW_LEN = 48;

function previewTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_PREVIEW_LEN
    ? `${oneLine.slice(0, TITLE_PREVIEW_LEN - 1)}…`
    : oneLine;
}

/**
 * Render one `wiki list` row: slug / version / age / status flag /
 * verified+confidence signals / title / tags. Deterministic given `nowMs`.
 */
export function renderWikiListRow(ref: WikiRef, nowMs: number): string {
  const age = humanAge(ref.updatedAt, nowMs).padStart(4);
  const statusCol = (ref.status === "published" ? "" : ref.status).padEnd(8);
  const signalsCol = `${ref.verified ? "✓" : " "}${ref.confidence.toFixed(2)}`;
  const tagsCol = ref.tags.length > 0 ? ` [${ref.tags.join(", ")}]` : "";
  return `  ${ref.slug.padEnd(28)}  v${String(ref.version).padEnd(3)}  ${age}  ${statusCol}  ${signalsCol}  ${previewTitle(ref.title)}${tagsCol}`;
}

/** Render the `wiki list` block for one spec's refs (already sorted). */
export function renderWikiList(
  specName: string,
  refs: ReadonlyArray<WikiRef>,
  nowMs: number,
): string[] {
  const verified = refs.filter((r) => r.verified).length;
  const lines = [
    `[wiki] ${specName} — ${refs.length} article(s), ${verified} verified (stalest first)`,
  ];
  for (const ref of refs) lines.push(renderWikiListRow(ref, nowMs));
  return lines;
}

/** Render `wiki show <slug>`: full frontmatter + the body verbatim. */
export function renderWikiShow(article: WikiArticle): string[] {
  const lines = [
    `slug:        ${article.slug}`,
    `title:       ${article.title}`,
    `version:     ${article.version}${article.supersedes !== undefined ? ` (supersedes v${article.supersedes} — priors in versions/${article.slug}/)` : ""}`,
    `status:      ${article.status}`,
    `verified:    ${article.verified}`,
    `confidence:  ${article.confidence.toFixed(2)}`,
    `tags:        ${article.tags.length > 0 ? article.tags.join(", ") : "(none)"}`,
    `sources:     ${article.sources.length > 0 ? article.sources.join(" · ") : "(none)"}`,
    `created:     ${article.createdAt}`,
    `updated:     ${article.updatedAt}`,
  ];
  if (article.createdBy !== undefined) {
    lines.push(
      `createdBy:   session ${article.createdBy.sessionId}${article.createdBy.agentIdentity !== undefined ? ` · ${article.createdBy.agentIdentity}` : ""}`,
    );
  }
  lines.push("", article.body);
  return lines;
}

/** Render `wiki search <q>` results (refs are already ranked best-first). */
export function renderWikiSearch(
  specName: string,
  query: string,
  refs: ReadonlyArray<WikiRef>,
): string[] {
  if (refs.length === 0) {
    return [`[wiki] ${specName} — no articles matched "${query}"`];
  }
  const lines = [`[wiki] ${specName} — ${refs.length} match(es) for "${query}":`];
  for (const ref of refs) {
    lines.push(`  ${ref.slug} (v${ref.version})  ${previewTitle(ref.title)}`);
  }
  return lines;
}

/** Render `wiki stats` for one spec. */
export function renderWikiStats(specName: string, stats: WikiStats): string[] {
  return [
    `[wiki] ${specName}`,
    `  articles:        ${stats.articles} (published ${stats.byStatus.published}, draft ${stats.byStatus.draft}, review ${stats.byStatus.review}, archived ${stats.byStatus.archived})`,
    `  prior versions:  ${stats.priorVersions}`,
    `  unique tags:     ${stats.uniqueTags}`,
    `  verified:        ${stats.verified}`,
    `  avg confidence:  ${stats.averageConfidence.toFixed(2)}`,
    `  link edges:      ${stats.links}`,
  ];
}
