/**
 * The inspection area: a run explained from its records, served over
 * `crewhaus.hangar.v1` (#518; `runs.create` takes `from` to run one again, #513). Static
 * data, like every area module. The read models are `@crewhaus/run-inspect`'s (module
 * brief 332 in `crewhaus/docs`): this module declares the operations that serve them, the
 * closed vocabulary of why part of a run cannot be shown, the grammar of a step's name,
 * and two capability keys.
 *
 * Every operation is a read: no receipt. A run another caller may not see is
 * `not_found`; a missing right is `forbidden` naming it; what this Home cannot answer is
 * `unsupported` with its reason and the command that helps. Without `h.read.content`, the
 * content fields (what was asked, the outcome, a wake's words, every timeline entry's
 * detail, the request's input) are left out and the answer says so (`hidden:
 * ["content"]`, a `no-access` gap).
 *
 * The core declares the `run`, `session` and `work` ref kinds and every permission used
 * here; this module declares none of them again.
 */
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

/** Why part of a run cannot be shown. Closed. */
export const INSPECT_GAP_REASONS = deepFreeze([
  "before-0.9",
  "records-off",
  "advisor-off",
  "cost-off",
  "not-supervised",
  "pruned",
  "evicted",
  "truncated",
  "torn",
  "unfinished",
  "diverged",
  "no-access",
  "unsupported",
  "not-recorded",
] as const);

export type InspectGapReason = (typeof INSPECT_GAP_REASONS)[number];

/** A step to explain: `tool:`, `answer:`, `model:` or `turn:` and its 16-hex span id. */
export const WHY_ACTION_RE = /^(tool|answer|model|turn):([0-9a-f]{16})$/;

/** A model call to show the context of: its number, or `all`. */
export const CONTEXT_CALL_RE = /^(?:all|[1-9][0-9]{0,6})$/;

/** What a timeline page shows: the key events, or everything recorded. */
export const TIMELINE_VIEWS = deepFreeze(["key", "full"] as const);

export type TimelineView = (typeof TIMELINE_VIEWS)[number];

/** The capability keys this area answers for a harness. */
export const INSPECTION_CAPABILITY_KEYS = deepFreeze(["inspect.records", "inspect.trace"] as const);

const READ = { receipt: "none", idempotency: "none" } as const;
const RUN_INSPECT = ["runs", "inspect", "{run}"] as const;

export const INSPECTION_MODULE = {
  area: "inspection",
  operations: [
    {
      ...READ,
      id: "inspect.summary",
      method: "GET",
      path: "/api/v1/runs/{run}/inspect",
      permission: "h.read",
      request: "noBody",
      response: "inspectSummary",
      cliTwin: { argv: [...RUN_INSPECT, "--harness", "{hrn}"] },
      qualifiers: ["content-fields"],
    },
    {
      ...READ,
      id: "inspect.timeline",
      method: "GET",
      path: "/api/v1/runs/{run}/timeline",
      permission: "h.read",
      request: "inspectTimelineQuery",
      response: "inspectTimeline",
      cliTwin: null,
      noTwinReason:
        "`crewhaus runs inspect <run> --timeline key|full` prints the same pages; the view is chosen in the query, which a twin does not carry.",
      qualifiers: ["content-fields"],
    },
    {
      ...READ,
      id: "inspect.why",
      method: "GET",
      path: "/api/v1/runs/{run}/why/{action}",
      permission: "h.read.content",
      request: "noBody",
      response: "inspectWhy",
      cliTwin: { argv: [...RUN_INSPECT, "--why", "{action}", "--harness", "{hrn}"] },
      qualifiers: [],
    },
    {
      ...READ,
      id: "inspect.context",
      method: "GET",
      path: "/api/v1/runs/{run}/context/{call}",
      permission: "h.read.content",
      request: "noBody",
      response: "inspectContext",
      cliTwin: { argv: [...RUN_INSPECT, "--context", "{call}", "--harness", "{hrn}"] },
      qualifiers: [],
    },
    {
      ...READ,
      id: "inspect.request",
      method: "GET",
      path: "/api/v1/runs/{run}/request",
      permission: "h.read",
      request: "noBody",
      response: "inspectRequest",
      cliTwin: null,
      noTwinReason:
        "The CLI has no request view; `crewhaus commands show <cmd>` shows the receipt that started the run.",
      qualifiers: ["content-fields"],
    },
    {
      ...READ,
      id: "inspect.export",
      method: "GET",
      path: "/api/v1/runs/{run}/export",
      permission: "h.read.content",
      request: "noBody",
      response: "inspectExport",
      cliTwin: null,
      noTwinReason: "`crewhaus runs inspect <run> --json` prints the same records, masked.",
      qualifiers: [],
    },
    {
      ...READ,
      id: "inspect.raw",
      method: "GET",
      path: "/api/v1/runs/{run}/raw",
      permission: "h.files.raw",
      request: "inspectRawQuery",
      response: "inspectRaw",
      cliTwin: null,
      noTwinReason:
        "The session log is a file in the harness's sessions folder; `crewhaus sessions tail <session>` prints it.",
      qualifiers: [],
    },
    {
      ...READ,
      id: "inspect.session",
      method: "GET",
      path: "/api/v1/harnesses/{h}/sessions/{sess}/inspect",
      permission: "h.read",
      request: "noBody",
      response: "inspectSession",
      cliTwin: { argv: ["runs", "inspect", "{sess}", "--harness", "{hrn}"] },
      qualifiers: ["content-fields"],
    },
    {
      ...READ,
      id: "inspect.work",
      method: "GET",
      path: "/api/v1/work/{ref}/inspect",
      permission: "h.read",
      request: "noBody",
      response: "inspectWork",
      cliTwin: null,
      noTwinReason: "`crewhaus work show <wi>` shows the work item and the runs that served it.",
      qualifiers: [],
      ref: { kind: "work", param: "ref" },
    },
  ],
  refKinds: [],
  eventFamilies: [],
  machines: {},
  commandKinds: [],
  permissions: [],
  capabilityKeys: [...INSPECTION_CAPABILITY_KEYS],
} as const satisfies AreaModule;

/** `inspect.timeline`'s query. */
export type InspectTimelineQuery = {
  readonly view?: TimelineView;
  /** 1 to 500; 50 when absent. */
  readonly limit?: number;
  /** An entry id: the page starts after it, older. */
  readonly before?: string;
  /** An entry id: only entries newer than it. Never with `before`. */
  readonly after?: string;
};

/** `inspect.raw`'s query. */
export type InspectRawQuery = {
  /** An entry id: the page starts after it, older. */
  readonly before?: string;
};

/** A record the folds shape, served as it is: its own fields are the read model's. */
type Loose = Readonly<Record<string, unknown>>;

/** Part of a run that cannot be shown, and why. */
export type InspectGapView = {
  readonly reason: InspectGapReason;
  readonly from?: string;
  readonly to?: string;
  readonly count?: number;
  readonly remedy?: string;
};

/** What an answer leaves out for a caller without the right to read content. */
export type InspectHidden = readonly "content"[];

/** `inspect.summary`: the first thing Home shows about a run. */
export type InspectSummaryAnswer = {
  readonly subject: Loose;
  readonly status: Loose;
  readonly trigger: Loose;
  readonly cost: Loose;
  readonly gaps: readonly InspectGapView[];
  readonly hidden?: InspectHidden;
};

/** One timeline entry: a fixed title, and where it sits. */
export type InspectTimelineEntry = {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly group: string;
  readonly importance: "key" | "detail";
  readonly title: string;
};

/** `inspect.timeline`: one page, newest first. */
export type InspectTimelineAnswer = {
  readonly entries: readonly InspectTimelineEntry[];
  readonly gaps: readonly InspectGapView[];
  readonly next?: string;
  readonly truncated: boolean;
  readonly empty?: "filtered" | "no-data";
  readonly view: TimelineView;
  readonly hidden?: InspectHidden;
};

/** `inspect.why`: why one step happened, from the record. */
export type InspectWhyAnswer = {
  readonly action: string;
  readonly kind: string;
  readonly span: string;
  readonly started: Loose;
  readonly used: Loose;
  readonly rules: Loose;
  readonly did: Loose;
  readonly options: Loose;
  readonly checks: Loose;
  readonly result: Loose;
  readonly gaps: readonly InspectGapView[];
};

/** `inspect.context`: what the model calls named were given. */
export type InspectContextAnswer = {
  readonly calls: readonly Loose[];
  readonly gaps: readonly InspectGapView[];
};

/** Where a shown request's input came from. */
export type InspectInputSource = "input-file" | "reconstructed";

/** `inspect.request`: what started a run through the API. */
export type InspectRequestAnswer = {
  readonly present: boolean;
  readonly note: string;
  readonly verb: string | null;
  /** The receipt that started it: operation, actor, door, retries and outcome. */
  readonly receipt?: Loose;
  readonly input?: { readonly source: InspectInputSource; readonly text: string } | null;
  readonly hidden?: InspectHidden;
};

/** `inspect.export`: the run's records as one JSON document to save. */
export type InspectExportAnswer = {
  readonly v: 1;
  readonly run: string;
  readonly summary: Loose;
  readonly timeline: readonly Loose[];
  readonly why: null;
  readonly gaps: readonly InspectGapView[];
  readonly truncated: boolean;
};

/** A block of model thinking inside a raw line: where it is, and what kind. */
export type InspectRawAnnotation = {
  readonly id: string;
  readonly path: readonly (string | number)[];
  readonly label: "thinking" | "redacted-thinking";
};

/** `inspect.raw`: the run's own session lines as written, newest first. */
export type InspectRawAnswer = {
  readonly entries: readonly { readonly id: string; readonly line: Loose }[];
  readonly annotations: readonly InspectRawAnnotation[];
  readonly next?: string;
  readonly truncated: boolean;
  readonly gaps: readonly InspectGapView[];
};

/** `inspect.session`: a session's summary, and the runs it holds. */
export type InspectSessionAnswer = {
  readonly summary: Loose;
  readonly sessionRuns: readonly string[];
};

/** Why a list is empty, and what fills it. */
export type InspectEmpty = {
  readonly reason: string;
  readonly note: string;
  readonly verb: string | null;
};

/** `inspect.work`: the runs that served a work item, newest first. */
export type InspectWorkAnswer = {
  readonly runs: readonly Loose[];
  readonly empty?: InspectEmpty;
};
