/** One minimal valid value per home schema. */
import { RECEIPT } from "./schema-examples";

export const EXAMPLES = {
  exportFormatQuery: { format: "csv" },
  specExport: {
    filename: "support-crewhaus.yaml",
    contentType: "application/yaml",
    text: "# Exported from Home.\nname: support\n",
    note: null,
  },
  evalResultsExport: {
    filename: "run_0123456789abcdef.csv",
    contentType: "text/csv",
    format: "csv",
    runId: "run_0123456789abcdef",
    text: "runId,sampleId\n",
    rows: 0,
    masked: true,
  },
  harnessExportAccepted: {
    receipt: RECEIPT,
    path: "/home/sam/.crewhaus/hangar/exports/hrn_0123456789abcdef/01J.tar.gz",
    command: "cd '/srv/support' && crewhaus state backup --out '/x.tar.gz'",
    job: { jobId: "job_1", state: "pending" },
  },
  harnessExportList: {
    exports: [{ name: "01J.tar.gz", bytes: 10, at: "2026-11-18T00:00:00.000Z" }],
    note: "kept on Home's computer",
  },
  homeStatus: {
    host: { name: "studio", loopback: true, reachedBy: "loopback" },
    version: "0.9.0",
    service: { installed: "unknown" },
    counts: { harnesses: 1, needsYou: 0 },
    asOf: "2026-11-18T00:00:00.000Z",
  },
  homeSpend: {
    rows: [
      {
        harness: "hrn_0123456789abcdef",
        name: "support",
        present: false,
        why: "no_period",
        note: "No spending limit for a period.",
        verb: "crewhaus budget show --harness hrn_0123456789abcdef",
      },
    ],
    totals: {
      harnesses: 0,
      capUsdMicros: 0,
      spentUsdMicros: 0,
      reservedUsdMicros: 0,
      unknownCalls: 0,
    },
    asOf: "2026-11-18T00:00:00.000Z",
  },
  harnessAccess: {
    harness: "hrn_0123456789abcdef",
    members: [
      {
        principal: "prn_01jc0000000000000000000001",
        name: "Sam",
        kind: "member",
        grants: [{ role: "operator", scope: "harness" }],
      },
    ],
    note: "People who can work on this harness.",
  },
};
