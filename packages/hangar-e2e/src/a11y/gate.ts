/**
 * The accessibility gate: every route the console serves must have no axe
 * violation at all, in both themes and at both widths, and the verdict over a
 * report.
 *
 * The gate is the router's own route templates (`ROUTE_TEMPLATES`, derived
 * from the destination and section tables), plus the states journey's rows.
 * There is no allow-list, no baseline and no parameter that can exempt a
 * rule, a node or a screen: a new route is in the gate the day its table row
 * lands, and it needs one line in `GATE_EXPECTS` naming what it must show.
 */
import { loadConsoleGrammar } from "../console-routes";
import { type AxeReport, rowKey } from "./baseline";

export const GATE_THEMES = ["dark", "light"] as const;
export const GATE_WIDTHS = [1280, 320] as const;

/** Every template the sweep gates: all of them. */
export async function gatedTemplates(): Promise<readonly string[]> {
  return (await loadConsoleGrammar()).templates;
}

/**
 * The screens the keyboard tour and the accessibility floor walk: the ones
 * first rebuilt on the shared accessible components, at their addresses
 * now. A short, named list, so neither journey grows with every route; the
 * axe sweep covers every route.
 */
export const TOURED_TEMPLATES: readonly string[] = [
  "#/harnesses",
  "#/home/needs-you?type=approvals",
  "#/home/needs-you?type=review",
  "#/home/changes",
  "#/home/needs-you?type=advice",
  "#/h/:id/overview/needs-you",
  "#/settings/readability",
  "#/h/:id",
  "#/h/:id/setup/budget",
  "#/h/:id/setup/spec",
  "#/h/:id/knowledge/memory",
  "#/connections/thredz",
  "#/h/:id/knowledge/thredz",
];

/**
 * What must be on each screen before axe runs. A sweep over an empty screen
 * proves nothing, so a seed that stops producing the content fails by name
 * rather than passing quietly. A heading alone is not content: each line
 * names what the screen exists to show. Exactly one entry per template.
 */
export const GATE_EXPECTS: Readonly<Record<string, string>> = {
  "#/": ".home-panel .home-item a",
  "#/home/needs-you": ".needs-you-section .inbox-card",
  "#/home/needs-you?type=approvals": ".inbox-card",
  "#/home/needs-you?type=review": ".inbox-card",
  "#/home/needs-you?type=advice": ".adv-board-row",
  "#/home/working": "table.fleet tbody tr",
  "#/home/changes": ".activity-body .activity-row",
  "#/harnesses": "table.fleet tbody.row-group",
  "#/harnesses/health": ".health-row-head a",
  "#/harnesses/feedback": "#view .page-body table.fleet tbody tr",
  "#/people": '[data-cause="unsupported"] code',
  "#/connections": ".section-index a",
  "#/connections/credentials": "#view .page-body table.fleet tbody tr",
  "#/connections/thredz": "#view .page-body table.fleet tbody tr",
  "#/settings": ".section-index a",
  "#/settings/readability": "#readability fieldset legend",
  "#/settings/notifications": '#view .page-body input[type="checkbox"]',
  "#/settings/home": "#view .page-body .card .dot-label",
  "#/settings/account": '#view .page-body button:text-is("Sign out")',
  "#/device": '#view .page-body label[for="device-code"]',
  "#/h/:id": "figure.chart",
  "#/h/:id/overview/needs-you": "figure.chart",
  "#/h/:id/work": ".section-index a",
  "#/h/:id/work/runs": "table.fleet tbody tr",
  "#/h/:id/work/runs/:run": ".run-feed > *",
  "#/h/:id/work/schedule": ".tab-body .lane-card",
  "#/h/:id/work/sessions": "table.fleet tbody tr",
  "#/h/:id/work/sessions/:session": ".transcript > *",
  "#/h/:id/quality": ".section-index a",
  "#/h/:id/quality/results": "table.fleet tbody tr",
  "#/h/:id/quality/datasets": "#view .tab-body form.row-editor",
  "#/h/:id/quality/feedback": "#view .tab-body .card .card-title + *",
  "#/h/:id/knowledge": ".section-index a",
  "#/h/:id/knowledge/memory": 'nav[aria-label="memory fabric panels"] [aria-current="true"]',
  "#/h/:id/knowledge/thredz": "#view .tab-body .card .dot-label",
  "#/h/:id/knowledge/wiki/:slug": "#view .tab-body .md",
  "#/h/:id/setup": ".section-index a",
  "#/h/:id/setup/spec": '[role="region"][aria-label="Version history"]',
  "#/h/:id/setup/tools": "#view .tab-body .card .card-title + *",
  "#/h/:id/setup/models":
    '#view .tab-body [role="region"][aria-label="Model profiles"], #view .tab-body .card p.muted',
  "#/h/:id/setup/channels": "#view .section-content .rollup .dot-off",
  "#/h/:id/setup/credentials": "#view .tab-body table.fleet tbody tr",
  "#/h/:id/setup/plugins": "#view .tab-body .empty",
  "#/h/:id/setup/security": "#view .tab-body .card .card-title + *",
  "#/h/:id/setup/delegations": "#view .tab-body .twin-cmd",
  "#/h/:id/setup/budget": "figure.chart",
  "#/h/:id/setup/deployment": "#view .tab-body .card .card-title + *",
  "#/h/:id/setup/files": '[role="region"][aria-label="Stores"]',
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
