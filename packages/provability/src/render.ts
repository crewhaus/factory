/**
 * The bundle beside the answer (design §5.4): one footer line, the JSON, the
 * research report's `## Provability` section, and the retry nudge. Every
 * surface renders the SAME bundle; these are its four spellings.
 *
 * The nudge is the one rendering the model reads, so it is the one with a
 * trust rule (§5.1): it is composed from the model's own sentences, the
 * evidence identifiers it cited, and fixed plain-words reasons — never from
 * a fetched body (no excerpt) and never from judge text — so it crosses no
 * trust boundary and needs no classification.
 */
import type { ProofBinding, ProofBundle, ProofClaim, UnmetReason } from "./types";
import { claimReasons, clip } from "./verify";

export type FooterOptions = {
  /** Where the bundle was persisted, shown last (`.crewhaus/proofs/…/turn-7.json`). */
  readonly path?: string;
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** An allowed assumption binding: never `ok` (it is not evidence), and not a failure either. */
const allowedAssumption = (b: ProofBinding): boolean =>
  b.kind === "assumption" && b.reason === undefined;

/**
 * The refs that failed in a failing answer's unmet claims (each once), and
 * how many claims cite nothing. An allowed assumption beside failing
 * evidence is not one of them: "[1] [A1]" with [1] wrong lists [1].
 */
function unmetRefs(bundle: ProofBundle): { refs: string[]; uncited: number } {
  const refs: string[] = [];
  let uncited = 0;
  for (const claim of bundle.claims) {
    if (claim.status !== "unmet") continue;
    if (claim.bindings.length === 0) uncited += 1;
    for (const b of claim.bindings) {
      if (!b.ok && !allowedAssumption(b) && !refs.includes(b.ref)) refs.push(b.ref);
    }
  }
  return { refs, uncited };
}

/**
 * Every assumption the answer rests on, accepted or refused — design §2:
 * assumptions are always counted, so one refused (`forbid`, or past
 * `max_assumptions`) still reads as an assumption, with how many were
 * refused beside it: `3 assumptions (2 refused)`. The hypotheses an
 * accepted proof rests on are assumptions too (§6.4, `hypotheses`): a
 * proof that assumes its own conclusion does not read "0 assumptions".
 */
function assumptionsCount(bundle: ProofBundle): number {
  return bundle.assumptions + (bundle.hypotheses ?? 0) + (bundle.assumptionsRefused ?? 0);
}

function assumptionsSegment(bundle: ProofBundle): string {
  const refused = bundle.assumptionsRefused ?? 0;
  const declared = plural(assumptionsCount(bundle), "assumption");
  return refused > 0 ? `${declared} (${refused} refused)` : declared;
}

function claimsSegment(bundle: ProofBundle): string {
  const counted = bundle.claimCount - bundle.assumptions;
  let text = `${bundle.met}/${counted} ${counted === 1 ? "claim" : "claims"}`;
  const notes: string[] = [];
  if (bundle.vacuous !== undefined) notes.push(bundle.vacuous);
  if (bundle.judgeWaived > 0) notes.push(`${bundle.judgeWaived} judge-waived`);
  if (notes.length > 0) text += ` (${notes.join(", ")})`;
  return text;
}

/**
 * One line, after the answer (design §5.4):
 *
 *   ── provability · grounded ✓ · 6/6 claims · 3 sources · 0 assumptions · <path>
 *   ── provability · grounded ✗ · 4/6 claims · unmet: [2] [5] · 3 sources · 0 assumptions · <path>
 *   ── provability · grounded ? unverified — <reason>
 *
 * `unmet:` lists the markers of the unmet claims' failing bindings — the
 * reader finds them in the answer — and `+N uncited` for claims with none.
 * Judge-waived bindings are counted separately: `6/6 claims (1 judge-waived)`,
 * and so are refused assumptions: `3 assumptions (2 refused)`, and sources
 * the run wrote itself: `3 sources (1 written by this run)`.
 */
export function renderFooter(bundle: ProofBundle, opts: FooterOptions = {}): string {
  const head = `── provability · ${bundle.level}`;
  const tail = opts.path !== undefined && opts.path !== "" ? ` · ${opts.path}` : "";
  if (bundle.verdict === "unverified") {
    return `${head} ? unverified — ${clip(bundle.error ?? "the verifier failed", 200)}${tail}`;
  }
  const parts = [`${head} ${bundle.verdict === "pass" ? "✓" : "✗"}`, claimsSegment(bundle)];
  if (bundle.verdict === "fail" || bundle.unmet > 0) {
    const { refs, uncited } = unmetRefs(bundle);
    const shown = refs.slice(0, 8);
    const listed = [...shown, ...(refs.length > shown.length ? ["…"] : [])];
    if (uncited > 0) listed.push(listed.length > 0 ? `+${uncited} uncited` : `${uncited} uncited`);
    if (listed.length > 0) parts.push(`unmet: ${listed.join(" ")}`);
  }
  parts.push(sourcesSegment(bundle), assumptionsSegment(bundle));
  return `${parts.join(" · ")}${tail}`;
}

/**
 * "N sources", and how many of them the run wrote itself before it read
 * them back (`selfWritten`, design §10): `2 sources (1 written by this run)`.
 */
function sourcesSegment(bundle: ProofBundle): string {
  const sources = plural(bundle.sources, "source");
  const own = bundle.selfWritten ?? 0;
  return own > 0 ? `${sources} (${own} written by this run)` : sources;
}

/** The bundle as pretty-printed JSON (`render: json`, `--json`). */
export function renderBundleJson(bundle: ProofBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** A rung or reason in words: `not_fetched` → `not fetched`. */
const words = (token: string): string => token.replace(/_/g, " ");

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function bindingCell(b: ProofBinding): string {
  if (allowedAssumption(b)) return `${b.ref} assumption`;
  if (b.ok) {
    const notes = [
      ...(b.judgeWaived === true ? ["judge-waived"] : []),
      ...(b.writtenBy !== undefined ? ["written by this run"] : []),
    ];
    return `${b.ref} ✓ ${b.rung}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
  }
  return `${b.ref} ✗ ${words(b.reason ?? "below_floor")}`;
}

function evidenceCell(claim: ProofClaim): string {
  if (claim.bindings.length === 0) return "✗ no citation";
  const cells = claim.bindings.map(bindingCell).join("; ");
  return claim.definition !== undefined
    ? `${cells} (text of definition ${claim.definition})`
    : cells;
}

const percent = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * The research report's `## Provability` section (design §5.4, §8): the
 * floor, the verdict, the score, a table of every claim with its status,
 * best rung and evidence, then the assumptions and the checkers whose
 * proofs back `proven` claims, each with its formal statement beside the
 * prose — the formalization gap shown, not hidden (§6.4).
 */
export function renderMarkdownSection(bundle: ProofBundle): string {
  const lines: string[] = ["## Provability", ""];
  const counted = bundle.claimCount - bundle.assumptions;
  if (bundle.verdict === "unverified") {
    lines.push(
      `**Floor:** \`${bundle.level}\` · **Verdict:** unverified — ${cell(
        bundle.error ?? "the verifier failed",
      )}`,
      "",
      "The claims of this report were not checked: the verifier failed, so no verdict is given.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `**Floor:** \`${bundle.level}\` · **Verdict:** ${
      bundle.verdict === "pass" ? "pass ✓" : "fail ✗"
    } · **Score:** ${bundle.met}/${counted} ${counted === 1 ? "claim" : "claims"} (${percent(bundle.score)}, threshold ${percent(
      bundle.threshold,
    )}) · **Achieved:** \`${bundle.achieved}\``,
  );
  if (bundle.vacuous !== undefined) lines.push("", `Vacuous pass: ${bundle.vacuous}.`);
  if (bundle.judgeWaived > 0) {
    lines.push(
      "",
      `${plural(bundle.judgeWaived, "binding was", "bindings were")} accepted by the paraphrase-waiver judge${
        bundle.judgeModel !== undefined ? ` (${bundle.judgeModel})` : ""
      } — an opinion, not a deterministic check.`,
    );
  }
  if ((bundle.selfWritten ?? 0) > 0) {
    lines.push(
      "",
      `${plural(bundle.selfWritten ?? 0, "source grounds", "sources ground")} only in text this run wrote there itself before reading it back — the run is its own source there.`,
    );
  }
  if (bundle.claims.length > 0) {
    lines.push("", "| # | Claim | Status | Best | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const claim of bundle.claims) {
      lines.push(
        `| ${claim.index + 1} | ${cell(clip(claim.text, 160))} | ${claim.status} | ${claim.best} | ${cell(
          evidenceCell(claim),
        )} |`,
      );
    }
  }
  // Declared assumptions, then the hypotheses each cited proof rests on.
  const assumed: Array<{ readonly ref: string; readonly text: string; readonly flag: string }> = [];
  for (const claim of bundle.claims) {
    for (const b of claim.bindings) {
      const refusal = b.reason !== undefined ? words(b.reason) : undefined;
      if (b.kind === "assumption" && b.origin !== undefined) {
        assumed.push({
          ref: b.ref,
          text: b.origin,
          flag: refusal !== undefined ? ` (${refusal})` : "",
        });
      } else if (b.kind === "formal" && b.assumptions !== undefined) {
        const of = `a hypothesis of ${b.origin ?? "the proof"}`;
        for (const hypothesis of b.assumptions) {
          assumed.push({
            ref: b.ref,
            text: hypothesis,
            flag: ` (${refusal !== undefined ? `${of}; ${refusal}` : of})`,
          });
        }
      }
    }
  }
  const refused = bundle.assumptionsRefused ?? 0;
  lines.push(
    "",
    `**Assumptions (${assumptionsCount(bundle)}${refused > 0 ? `, ${refused} refused` : ""}):**${
      assumed.length === 0 ? " none" : ""
    }`,
  );
  const seen = new Set<string>();
  for (const { ref, text, flag } of assumed) {
    const key = `${ref} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${ref} ${cell(text)}${flag}`);
  }
  if (bundle.checkers !== undefined && bundle.checkers.length > 0) {
    lines.push("", "**Checkers:**");
    const statements = new Map<string, string>();
    for (const claim of bundle.claims) {
      for (const b of claim.bindings) {
        if (b.kind === "formal" && b.origin !== undefined && b.statement !== undefined) {
          statements.set(b.origin, b.statement);
        }
      }
    }
    for (const checker of bundle.checkers) {
      const statement = statements.get(checker.artifact);
      // What the proof rests on, beside its statement (§6.4): the
      // hypotheses, when any, then the axioms.
      const hypotheses = checker.assumptions ?? [];
      const assuming =
        hypotheses.length > 0
          ? `assuming: ${hypotheses.map((h) => cell(clip(h, 120))).join("; ")}; `
          : "";
      lines.push(
        `- \`${checker.id}\` — ${checker.artifact}${
          statement !== undefined ? `: \`${cell(clip(statement, 200)).replace(/`/g, "'")}\`` : ""
        } (${assuming}axioms: ${checker.axioms.length === 0 ? "none" : checker.axioms.join(", ")})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Each reason in plain words, for the nudge. ASCII only. */
const REASON_WORDS: Readonly<Record<UnmetReason, string>> = {
  no_citation:
    "no citation - add a marker like [1] and a definition line [1]: <source> at the end of the answer",
  no_definition: "the marker has no definition line - add one such as [1]: <source>",
  not_locatable: "this is not a URL, a doi: or a workspace path, so it cannot be checked",
  host_denied: "this host is not accepted as a source here (provability.sources)",
  private_address: "a loopback, private or link-local address is not a source",
  path_outside_workspace: "this path is outside the workspace",
  path_missing: "this file does not exist in the workspace",
  unresolved: "the URL did not answer a HEAD request with 2xx or 3xx",
  not_fetched: "this run never fetched or read it - fetch or read it first, then cite it",
  not_found_in_source:
    "the source was read, but the claim's words are not in it together - quote the source, or restate the claim in its words",
  polarity_conflict:
    "the source has these words with a negation the claim lacks - check what it actually says",
  not_independent: "needs more independent origins - also cite a different site that says the same",
  tool_missing: "no tool call with this id was recorded - run the tool and cite its toolUseId",
  tool_errored: "that tool call returned an error - rerun it and cite the successful call",
  tool_not_allowed:
    "results of this tool do not count as evidence here (provability.execution.allow)",
  value_absent:
    "the tool result does not contain the values the claim states - restate them exactly as the result gives them",
  replay_mismatch:
    "re-running the tool with the logged input gave a different output - rerun it and cite the new call",
  proof_missing: "no proof artifact has this id - run ProofCheck and cite the id it returns",
  proof_rejected: "the checker rejected the proof - fix the proof or the claim",
  claim_mismatch: "the proof is of a different statement than this sentence makes",
  assumption_forbidden:
    "this assumption is not accepted (assumptions are forbidden, or there are too many) - prove the claim or drop it",
  below_floor: "this evidence is below the floor",
};

/**
 * Reasons whose `detail` the nudge repeats. Every detail the verifier writes
 * is built from identifiers, the model's own words and checker verdicts —
 * never a fetched body — but the nudge repeats only the ones that tell the
 * model what to change, so what it reads stays short.
 */
const NUDGE_DETAIL: ReadonlySet<UnmetReason> = new Set<UnmetReason>([
  "value_absent",
  "not_found_in_source",
  "proof_rejected",
  "claim_mismatch",
  "not_independent",
  "below_floor",
  "assumption_forbidden",
  "unresolved",
  "host_denied",
  "tool_not_allowed",
]);

const MAX_NUDGE_CLAIMS = 20;

/**
 * Typography folded to ASCII — quotes, dashes and the ellipsis `clip` cuts
 * with — applied to everything the nudge repeats (the model's sentences,
 * the identifiers it cited, the verifier's details), so the nudge's own
 * text is ASCII. Other characters of the model's own words are its own and
 * are repeated as written.
 */
const ascii = (text: string): string =>
  text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[—–−]/g, "-")
    .replace(/…/g, "...");

function nudgeLine(b: ProofBinding): string {
  const reason = b.reason ?? "below_floor";
  const at = b.origin !== undefined ? ` ${ascii(clip(b.origin, 160))}` : "";
  const detail =
    NUDGE_DETAIL.has(reason) && b.detail !== undefined ? ` (${ascii(clip(b.detail, 300))})` : "";
  return `   - ${b.ref}${at}: ${REASON_WORDS[reason]}${detail}`;
}

/**
 * The retry nudge (design §5.1): which claims fell short, in the model's own
 * words, what each cited and why it did not count — and the standing
 * instruction to run `ProvabilityPreflight` on the next draft. No excerpt,
 * no fetched text, no judge text.
 */
export function renderNudge(bundle: ProofBundle): string {
  const counted = bundle.claimCount - bundle.assumptions;
  if (bundle.verdict === "unverified") {
    return "The provability gate could not verify your last answer (its verifier failed), so it was not graded. Keep citing every claim; run ProvabilityPreflight on your next draft.";
  }
  const lines: string[] = [];
  lines.push(
    bundle.verdict === "pass"
      ? `The provability gate accepted your last answer at the ${bundle.level} floor: ${bundle.met} of ${counted} claims meet it.`
      : `The provability gate did not accept your last answer. Floor: ${bundle.level}. ${bundle.met} of ${counted} claims meet it; at least ${percent(bundle.threshold)} must.`,
  );
  const refused = bundle.assumptionsRefused ?? 0;
  if (refused > 0) {
    lines.push(
      "",
      `${refused === 1 ? "1 declared assumption was" : `${refused} declared assumptions were`} refused (provability.assumptions is forbid, or there are more than provability.max_assumptions allows). A refused assumption fails the answer whatever the score: prove those claims, cite evidence for them, or drop them.`,
    );
  }
  const unmet = bundle.claims.filter((claim) => claim.status === "unmet");
  if (unmet.length > 0) {
    lines.push("", "Claims that do not meet the floor:");
    unmet.slice(0, MAX_NUDGE_CLAIMS).forEach((claim, i) => {
      const where =
        claim.definition !== undefined
          ? ` (the text after the source on your definition line ${claim.definition})`
          : "";
      lines.push(`${i + 1}. "${ascii(clip(claim.text, 200))}"${where}`);
      if (claim.bindings.length === 0) {
        lines.push(`   - ${REASON_WORDS[claimReasons(claim)[0] ?? "no_citation"]}`);
        return;
      }
      for (const b of claim.bindings) if (!b.ok && b.reason !== undefined) lines.push(nudgeLine(b));
    });
    if (unmet.length > MAX_NUDGE_CLAIMS) {
      lines.push(`... and ${unmet.length - MAX_NUDGE_CLAIMS} more.`);
    }
  }
  lines.push(
    "",
    "Cite every claim with a marker such as [1] and close the answer with one definition line per marker: [1]: https://... (a page you fetched), ./path (a file you read), doi:..., tool:<toolUseId> (a computation you ran), proof:prf_... (a ProofCheck artifact), or assume: <text> (a declared assumption).",
  );
  if (unmet.some((claim) => claim.definition !== undefined)) {
    lines.push(
      'Text after the source on a definition line is shown to the reader, so it is checked as a claim citing that source: put a page title in quotes ([1]: https://... "Title") or leave it out.',
    );
  }
  lines.push(
    "Before you finish your next draft, run ProvabilityPreflight on it and fix every claim it reports.",
  );
  return lines.join("\n");
}
