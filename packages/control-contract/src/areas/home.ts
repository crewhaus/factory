/**
 * The home area: what Home itself lets a person take away from a harness, and what Home
 * says about itself (#524, #507, #513). Static data, like every area module.
 *
 * Home's own reads: its status line (`home.status`: which host it runs on and how it is
 * reached, and its harnesses counted by what they are doing, only those the caller may
 * read), this period's spend of every harness the caller may read (`home.spend`), and who
 * may work on one harness (`home.harnessAccess`). A count or an amount Home cannot know is
 * left out with a note, never shown as zero.
 *
 * Exports: the spec as the masked YAML Home shows, one evaluation run's results as CSV or
 * JSONL, and the whole harness as an archive Home writes on its own computer, under its
 * own folder, through `crewhaus state backup`. The spec and results answers are JSON
 * envelopes the browser saves, so every one passes the same masker as any other answer;
 * the archive is never sent to a browser.
 *
 * The core declares the `harness`, `evalrun` and `session` ref kinds and every permission
 * used here; this module declares none of them again.
 */
import { TWINS } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

/** What an evaluation results export can be. */
export const EXPORT_FORMATS = deepFreeze(["csv", "jsonl"] as const);

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** `exports.spec`: the masked spec, ready to save. */
export type SpecExport = {
  readonly filename: string;
  readonly contentType: "application/yaml";
  /** The masked YAML, its first line saying so. */
  readonly text: string;
  /** Where the real file is on Home's computer, for a caller who sees host paths. */
  readonly note: string | null;
};

/** `exports.evalResults`: one run's rows, as CSV or JSONL, masked. */
export type EvalResultsExport = {
  readonly filename: string;
  readonly contentType: "text/csv" | "application/x-ndjson";
  readonly format: ExportFormat;
  readonly runId: string;
  readonly text: string;
  readonly rows: number;
  readonly masked: true;
};

/** What `exports.harness` answers beside its receipt: where the archive goes, and how. */
export type HarnessExportStarted = {
  /** The archive's path on Home's computer. */
  readonly path: string;
  /** The command the job runs, as it would be typed in the harness folder. */
  readonly command: string;
  /** The job that writes it; `null` on a repeated request, which starts nothing new. */
  readonly job: { readonly jobId: string; readonly state: string } | null;
};

/** One archive in a harness's exports folder. */
export type HarnessExportRow = {
  readonly name: string;
  readonly bytes: number;
  readonly at: string;
};

/** `exports.list`: the archives Home wrote for a harness, newest first. */
export type HarnessExportList = {
  readonly exports: readonly HarnessExportRow[];
  readonly note: string;
};

/** How a browser reached Home: on its own computer, over the local network, or through a proxy. */
export const HOME_REACHED_BY = deepFreeze(["loopback", "lan", "proxy"] as const);

export type HomeReachedBy = (typeof HOME_REACHED_BY)[number];

/** The status line's counts; a count Home cannot know is absent, with a note. */
export type HomeStatusCounts = {
  readonly harnesses?: number;
  readonly needsYou?: number;
  readonly working?: number;
  readonly paused?: number;
  readonly notResponding?: number;
  readonly waitingForBudget?: number;
};

/** `home.status`: Home's host, its version, its service, and its harnesses by state. */
export type HomeStatus = {
  readonly host: {
    readonly name: string;
    readonly loopback: boolean;
    readonly reachedBy: HomeReachedBy;
  };
  readonly version: string;
  readonly service: {
    /** Whether Home runs as a service on its computer; `unknown` when it cannot tell. */
    readonly installed: boolean | "unknown";
    readonly autostart?: boolean;
  };
  readonly counts: HomeStatusCounts;
  /** Why a count is left out, one line per count. */
  readonly notes?: readonly { readonly count: string; readonly note: string }[];
  readonly asOf: string;
};

/** One harness's spend this period, from its budget fold. Unknown is never `$0`. */
export type SpendRow = {
  readonly harness: string;
  readonly name: string;
  /** Whether the harness has a period to report: `false` names why in `why` and `note`. */
  readonly present: boolean;
  readonly why?: "no_period" | "spec_unreadable";
  readonly note: string;
  readonly verb: string;
  readonly periodId?: string;
  readonly every?: "day" | "week" | "month";
  readonly renewsAt?: string;
  readonly timezone?: string;
  readonly capUsdMicros?: number;
  readonly extensionsUsdMicros?: number;
  readonly spentUsdMicros?: number;
  readonly reservedUsdMicros?: number;
  /** Settled calls nothing could price: their cost is unknown. */
  readonly unknownCalls?: number;
  readonly exhausted?: boolean;
  /** Lines past the read caps were left out, so the amounts are lower bounds. */
  readonly truncated?: boolean;
};

/** `home.spend`: this period's spend of every harness the caller may read, and its total. */
export type HomeSpend = {
  readonly rows: readonly SpendRow[];
  readonly totals: {
    /** Harnesses with a period, counted in the totals. */
    readonly harnesses: number;
    readonly capUsdMicros: number;
    readonly spentUsdMicros: number;
    readonly reservedUsdMicros: number;
    readonly unknownCalls: number;
    /** Some cost is unknown or was not read, so the totals are at least these. */
    readonly lowerBound?: true;
  };
  readonly asOf: string;
};

/** One of a member's grants that covers a harness, in plain terms. */
export type HarnessAccessGrant = {
  readonly role: string;
  /** Where the grant applies: the whole Home, a group, or this harness. */
  readonly scope: "home" | "group" | "harness";
  readonly expiresAt?: string;
};

/** Someone who may work on a harness: no secret, no linked-account id. */
export type HarnessAccessMember = {
  readonly principal: string;
  readonly name?: string;
  readonly kind: "member" | "service";
  readonly grants: readonly HarnessAccessGrant[];
};

/** `home.harnessAccess`: who may work on one harness. */
export type HarnessAccess = {
  readonly harness: string;
  readonly members: readonly HarnessAccessMember[];
  readonly note: string;
};

const SAVED_HERE =
  "Home writes the archive on its own computer and names the path; copy it from there. `crewhaus state backup --out <path>` makes one in the harness folder.";

export const HOME_MODULE = {
  area: "home",
  operations: [
    {
      id: "exports.spec",
      method: "GET",
      path: "/api/v1/harnesses/{h}/spec/export",
      permission: "h.read",
      receipt: "none",
      idempotency: "none",
      request: "noBody",
      response: "specExport",
      cliTwin: null,
      noTwinReason:
        "The spec is the harness folder's `crewhaus.yaml`; this export is the masked copy Home shows.",
      qualifiers: [],
    },
    {
      id: "exports.evalResults",
      method: "GET",
      path: "/api/v1/harnesses/{h}/evalruns/{run}/export",
      permission: "h.read.content",
      receipt: "none",
      idempotency: "none",
      request: "exportFormatQuery",
      response: "evalResultsExport",
      cliTwin: null,
      noTwinReason:
        "`crewhaus eval-report export --runs <run-dir> --format csv` writes the same rows, unmasked, in the harness folder.",
      qualifiers: [],
    },
    {
      id: "exports.harness",
      method: "POST",
      path: "/api/v1/harnesses/{h}/exports",
      permission: "h.files.raw",
      receipt: "harness",
      idempotency: "accepted",
      request: "emptyRequest",
      response: "harnessExportAccepted",
      cliTwin: null,
      noTwinReason: SAVED_HERE,
      qualifiers: [],
    },
    {
      id: "exports.list",
      method: "GET",
      path: "/api/v1/harnesses/{h}/exports",
      permission: "h.files.raw",
      receipt: "none",
      idempotency: "none",
      request: "noBody",
      response: "harnessExportList",
      cliTwin: null,
      noTwinReason: "The archives are files in Home's own folder; no command lists them.",
      qualifiers: [],
    },
    {
      id: "home.status",
      method: "GET",
      path: "/api/v1/home/status",
      permission: "home.read",
      receipt: "none",
      idempotency: "none",
      request: "noBody",
      response: "homeStatus",
      cliTwin: TWINS.hangarStatus,
      qualifiers: ["filtered"],
    },
    {
      id: "home.spend",
      method: "GET",
      path: "/api/v1/spend",
      permission: "home.read",
      receipt: "none",
      idempotency: "none",
      request: "noBody",
      response: "homeSpend",
      cliTwin: null,
      noTwinReason:
        "Home lists every harness here; `crewhaus budget show --harness <id>` shows one.",
      qualifiers: ["filtered"],
    },
    {
      id: "home.harnessAccess",
      method: "GET",
      path: "/api/v1/harnesses/{h}/access",
      permission: "h.access.view",
      receipt: "none",
      idempotency: "none",
      request: "noBody",
      response: "harnessAccess",
      cliTwin: null,
      noTwinReason:
        "`crewhaus access members` lists everyone with access to this Home; no command narrows it to one harness.",
      qualifiers: [],
    },
  ],
  refKinds: [],
  eventFamilies: [],
  machines: {},
  commandKinds: [
    {
      id: "exports.harness",
      permission: "h.files.raw",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
  ],
  permissions: [],
} as const satisfies AreaModule;
