/**
 * NEW-HUNT-11 — `crewhaus graders card`: render a graders.yaml as a
 * MARKDOWN RUBRIC CARD — the measurement-instrument documentation artifact
 * the release checklist attaches next to a dataset's registry record.
 * Datasets are versioned, hashed artifacts; the graders file is the other
 * half of the instrument and deserves the same reviewable identity.
 *
 * The card documents, per grader: its type and every declared option /
 * threshold; for `llm_judge` entries the full rubric (criteria + anchors,
 * or categorical labels + passing set), the passing cut, and the decoding
 * setup (panel models, repeats, temperature, target); for `registry`
 * entries the pack name and the `opts:` wiring record. The header carries
 * the config's gradersHash — computed by the CALLER with the exact
 * function the run-history index and baseline pins record (`index.ts`'s
 * `hashGradersConfig`), so the card's identity line and history's
 * instrument-mismatch guard can never disagree.
 *
 * Deliberately deterministic: no wall clock, no randomness, no timestamps
 * AT ALL — every identity line is derived from CONTENT (the gradersHash),
 * so re-rendering an unchanged config is byte-identical in any checkout
 * and a card diff in a release PR shows real instrument changes only (an
 * mtime line would diff on every fresh clone/checkout/touch with zero
 * instrument change, contradicting exactly that contract).
 * Side-effect-free module (the CLI entry file runs an argv switch on
 * import), mirroring `graders-test.ts`; flag parsing and filesystem access
 * live in `apps/cli/src/index.ts`.
 */
import type { GraderSpec, GradersConfig } from "@crewhaus/eval-grader";

export type GradersCardInput = {
  readonly config: GradersConfig;
  /** sha256 of the parsed config — MUST be the run-history hash
   *  (`hashGradersConfig`), never recomputed differently here. */
  readonly gradersHash: string;
  /** The graders path as the user gave it (the card's title). */
  readonly source: string;
};

/** The runner-side default passing cut for a scalar rubric that declares
 *  none (eval-judge `RubricSchema`'s `passing_score` default). */
const DEFAULT_PASSING_SCORE = 3;
/** The runner-side default pass cut for `combine: weighted` when the
 *  config declares no `passing_threshold`. */
const DEFAULT_WEIGHTED_THRESHOLD = 0.5;

/** Render one option value for a card table cell. Strings are shown
 *  verbatim; arrays join with ", "; everything else JSON-stringifies. */
function cell(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => cell(v)).join(", ");
  return JSON.stringify(value);
}

function optionRows(spec: GraderSpec): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  rows.push(["weight", spec.weight !== undefined ? cell(spec.weight) : "1 (default)"]);
  switch (spec.type) {
    case "exact_match":
      if (spec.trim !== undefined) rows.push(["trim", cell(spec.trim)]);
      if (spec.case_insensitive !== undefined) {
        rows.push(["case_insensitive", cell(spec.case_insensitive)]);
      }
      break;
    case "contains":
      rows.push(["substring", cell(spec.substring)]);
      if (spec.case_insensitive !== undefined) {
        rows.push(["case_insensitive", cell(spec.case_insensitive)]);
      }
      break;
    case "expected_contains":
      if (spec.case_insensitive !== undefined) {
        rows.push(["case_insensitive", cell(spec.case_insensitive)]);
      }
      break;
    case "regex":
      rows.push(["pattern", `\`${spec.pattern}\``]);
      if (spec.flags !== undefined) rows.push(["flags", cell(spec.flags)]);
      break;
    case "json_path":
      rows.push(["path", `\`${spec.path}\``]);
      if (spec.expected !== undefined) rows.push(["expected", cell(spec.expected)]);
      break;
    case "tool_call_sequence":
      rows.push(["expected", cell(spec.expected)]);
      rows.push(["mode", spec.mode ?? "exact (default)"]);
      break;
    case "llm_judge": {
      if (spec.judges !== undefined) {
        rows.push([
          "judges (panel)",
          `${cell(spec.judges)} — median score, strict-majority pass, vote entropy recorded`,
        ]);
      } else {
        rows.push(["model", spec.model ?? "(runner default / --judge-model)"]);
      }
      rows.push([
        "temperature",
        spec.temperature !== undefined ? cell(spec.temperature) : "0 (pinned default)",
      ]);
      rows.push([
        "repeats",
        spec.repeats !== undefined
          ? `${cell(spec.repeats)} (median${spec.judges !== undefined ? ", per panelist" : ""})`
          : "1 (default)",
      ]);
      rows.push(["target", spec.target ?? "output (default)"]);
      if (spec.rubric.kind === "categorical") {
        rows.push(["passing labels", cell(spec.rubric.passing_labels)]);
      } else {
        rows.push([
          "passing cut",
          spec.rubric.passing_score !== undefined
            ? `score >= ${cell(spec.rubric.passing_score)} of 5`
            : `score >= ${DEFAULT_PASSING_SCORE} of 5 (schema default; a calibrated cut from \`judge calibrate --apply\` overrides at run time)`,
        ]);
      }
      break;
    }
    case "registry": {
      const opts = spec.opts;
      if (opts === undefined || Object.keys(opts).length === 0) {
        rows.push(["opts", "(none — pack defaults)"]);
      } else {
        for (const [key, value] of Object.entries(opts)) {
          rows.push([`opts.${key}`, cell(value)]);
        }
      }
      break;
    }
  }
  return rows;
}

/** Markdown-table hardening for user content: an unescaped `|` splits the
 *  cell in every renderer — GFM splits on pipes even inside code spans
 *  (alternation regexes like `^(yes|no)$` are among the most common grader
 *  patterns) — and a raw newline ends the row. Escaped/flattened at the ONE
 *  seam every cell passes through; `\|` renders as a literal pipe,
 *  including inside code spans. */
function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function table(header: readonly [string, string], rows: ReadonlyArray<[string, string]>): string[] {
  return [
    `| ${header[0]} | ${header[1]} |`,
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${tableCell(k)} | ${tableCell(v)} |`),
  ];
}

function combineLine(config: GradersConfig): string {
  const declared = config.combine !== undefined || config.passing_threshold !== undefined;
  const mode = config.combine ?? "all";
  switch (mode) {
    case "any":
      return "- **combine**: `any` — passed iff any grader passed; score = max";
    case "weighted": {
      const cut = config.passing_threshold ?? DEFAULT_WEIGHTED_THRESHOLD;
      const cutNote = config.passing_threshold !== undefined ? "" : " (default)";
      return `- **combine**: \`weighted\` — score = weighted mean; pass at combined score >= ${cut}${cutNote}`;
    }
    default:
      return `- **combine**: \`all\`${declared ? "" : " (default)"} — passed iff every grader passed; score = unweighted mean`;
  }
}

function judgeRubricSection(spec: Extract<GraderSpec, { type: "llm_judge" }>): string[] {
  const lines: string[] = [];
  if (spec.rubric.kind === "categorical") {
    const passing = new Set(spec.rubric.passing_labels);
    lines.push(
      "",
      "**Labels** (the judge picks exactly one; score = the label's declared score):",
      "",
    );
    lines.push(
      ...table(
        ["label", "value"],
        spec.rubric.labels.map((l): [string, string] => [
          `\`${l.name}\``,
          `score ${l.score}${passing.has(l.name) ? ", **passes**" : ""} — ${l.description}`,
        ]),
      ),
    );
    return lines;
  }
  lines.push("", "**Criteria** (scored 1–5 per the anchors; overall = rounded unweighted mean):");
  for (const criterion of spec.rubric.criteria) {
    lines.push("", `**${criterion.name}** — ${criterion.description}`, "");
    lines.push(
      ...table(
        ["anchor", "meaning"],
        (["1", "2", "3", "4", "5"] as const).map((k): [string, string] => [
          k,
          criterion.anchors[k],
        ]),
      ),
    );
  }
  return lines;
}

/**
 * Render the full markdown rubric card. Pure: same input, same bytes —
 * see the module doc for the determinism contract.
 */
export function renderGradersCard(input: GradersCardInput): string {
  const { config } = input;
  const judgeCount = config.graders.filter((g) => g.type === "llm_judge").length;
  const registryCount = config.graders.filter((g) => g.type === "registry").length;
  const deterministicCount = config.graders.length - judgeCount - registryCount;

  const lines: string[] = [];
  lines.push(`# Grader rubric card — ${input.source}`);
  lines.push("");
  lines.push(
    "The measurement instrument behind this eval, as configured. Any edit to the graders file",
    "changes the gradersHash below — history and baselines treat that as a NEW instrument, so",
    "attach a regenerated card to the change that edits it.",
  );
  lines.push("");
  lines.push(
    `- **gradersHash**: \`${input.gradersHash}\` — the instrument identity recorded in run.json, the run-history index, and baseline pins`,
  );
  lines.push(combineLine(config));
  lines.push(
    `- **graders**: ${config.graders.length} (${judgeCount} llm_judge, ${registryCount} registry, ${deterministicCount} deterministic)`,
  );

  config.graders.forEach((spec, i) => {
    const suffix =
      spec.type === "llm_judge"
        ? ` (${spec.rubric.kind === "categorical" ? "categorical" : "scalar"} rubric)`
        : spec.type === "registry"
          ? ` → \`${spec.grader}\``
          : "";
    lines.push("", `## ${i + 1}. ${spec.name} — \`${spec.type}\`${suffix}`, "");
    lines.push(...table(["option", "value"], optionRows(spec)));
    if (spec.type === "llm_judge") lines.push(...judgeRubricSection(spec));
  });

  return `${lines.join("\n")}\n`;
}
