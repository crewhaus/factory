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
};
