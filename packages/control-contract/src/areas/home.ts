/**
 * The home area: what Home itself lets a person take away from a harness (#524, #507,
 * #513). Static data, like every area module.
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
