/**
 * The accessibility gate: the screens that must have no axe violation at
 * all, in both themes and at both widths, and the verdict over a report.
 *
 * There is no allow-list and no parameter that can exempt a rule or a node:
 * a screen is in the gate or it is not. Every other screen still reports
 * against the committed baseline (`baseline.ts`) and never fails.
 */
import { type AxeReport, rowKey } from "./baseline";

export const GATE_THEMES = ["dark", "light"] as const;
export const GATE_WIDTHS = [1280, 320] as const;

/**
 * The gated screens: the ones rebuilt on the shared accessible components
 * (tokens, focus ring, dialogs, tooltips, roving lists, charts, empty states).
 * A screen joins when it has been moved onto them; append one per line.
 */
export const GATED_TEMPLATES: readonly string[] = [
  "#/",
  "#/approvals",
  "#/review",
  "#/activity",
  "#/advisor",
  "#/h/:id/advisor",
  "#/settings",
  "#/h/:id/overview",
  "#/h/:id/costs",
  "#/h/:id/spec",
  "#/h/:id/memory",
  "#/thredz",
  "#/h/:id/thredz",
];

/**
 * What must be on each gated screen before axe runs. A sweep over an empty
 * screen proves nothing, so a seed that stops producing the content fails by
 * name rather than passing quietly. One entry per gated template, no more.
 */
export const GATE_EXPECTS: Readonly<Record<string, string>> = {
  "#/": "table.fleet tbody.row-group",
  "#/approvals": ".inbox-card",
  "#/review": ".inbox-card",
  "#/activity": ".activity-body .activity-row",
  "#/advisor": ".adv-board-row",
  "#/h/:id/advisor": "figure.chart",
  "#/settings": "#readability fieldset legend",
  "#/h/:id/overview": "figure.chart",
  "#/h/:id/costs": "figure.chart",
  "#/h/:id/spec": '[role="region"][aria-label="Version history"]',
  "#/h/:id/memory": 'nav[aria-label="memory fabric panels"] [aria-current="true"]',
  "#/thredz": "#view .card",
  "#/h/:id/thredz": "#view .card",
};

export type GateFailure = {
  readonly template: string;
  readonly theme: string;
  readonly width: number;
  readonly rule: string;
  readonly count: number;
};

export type GateVerdict = {
  /** Every rule with a node on a gated row. */
  readonly failures: readonly GateFailure[];
  /** `template theme width` for each gated row the report does not hold. */
  readonly missing: readonly string[];
};

/** The gate over a report. Pure. */
export function gateVerdict(report: AxeReport, gated: readonly string[]): GateVerdict {
  const failures: GateFailure[] = [];
  const missing: string[] = [];
  for (const template of gated) {
    for (const theme of GATE_THEMES) {
      for (const width of GATE_WIDTHS) {
        const row = report.rows[rowKey(template, theme, width)];
        if (row === undefined) {
          missing.push(`${template} ${theme} ${width}`);
          continue;
        }
        for (const rule of Object.keys(row).sort()) {
          const count = row[rule] ?? 0;
          if (count > 0) failures.push({ template, theme, width, rule, count });
        }
      }
    }
  }
  return { failures, missing };
}

/** `template|theme|width` → rule → node targets, as the sweep collects them. */
export type GateSamples = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** The verdict as the message a failed build shows, naming every failure. */
export function gateMessage(verdict: GateVerdict, samples: GateSamples = {}): string {
  const lines = verdict.failures.map((f) => {
    const nodes = samples[rowKey(f.template, f.theme, f.width)]?.[f.rule] ?? [];
    return `  ${f.template} ${f.theme} ${f.width}: ${f.rule} on ${f.count} node${f.count === 1 ? "" : "s"}${
      nodes.length > 0 ? ` (${nodes.join(", ")})` : ""
    }`;
  });
  const missing = verdict.missing.map((m) => `  ${m}: no row`);
  return [
    `the accessibility gate failed: ${verdict.failures.length} violation(s), ${verdict.missing.length} missing row(s)`,
    ...lines,
    ...missing,
  ].join("\n");
}
