/** One minimal valid value per inspection schema. */

const RUN = "run_01JD0000000000000000000000";
const GAPS = [{ reason: "not-supervised", remedy: "crewhaus daemon start" }];

export const EXAMPLES = {
  inspectTimelineQuery: { view: "full", limit: 20, before: "s:1200" },
  inspectRawQuery: { before: "s:1200" },
  inspectSummary: {
    subject: { kind: "run", run: RUN, session: "sess_00000000000000a1" },
    status: { state: "recorded", value: { state: "succeeded", word: "Finished" }, refs: [] },
    trigger: { state: "recorded", value: { kind: "cli", words: "Started from the command line" } },
    cost: { state: "recorded", value: { usdMicros: 1200, lines: 1, words: "under $0.01" } },
    gaps: GAPS,
  },
  inspectTimeline: {
    entries: [
      {
        id: "s:0",
        at: "2026-11-14T11:59:00.000Z",
        kind: "run-start",
        group: "run",
        importance: "key",
        title: "Run started: Started from the command line",
      },
    ],
    gaps: GAPS,
    truncated: false,
    view: "key",
  },
  inspectWhy: {
    action: "tool:0000000000000104",
    kind: "tool",
    span: "0000000000000104",
    started: { state: "recorded", refs: [] },
    used: { state: "recorded", refs: [] },
    rules: { state: "recorded", refs: [] },
    did: { state: "recorded", refs: [] },
    options: { state: "recorded", refs: [] },
    checks: { state: "recorded", refs: [] },
    result: { state: "recorded", refs: [] },
    gaps: [],
  },
  inspectContext: { calls: [{ call: 1, span: "0000000000000103", id: "s:40" }], gaps: [] },
  inspectRequest: {
    present: false,
    note: "This run was not started through the API.",
    verb: null,
  },
  inspectExport: {
    v: 1,
    run: RUN,
    summary: { subject: { kind: "run", run: RUN } },
    timeline: [],
    why: null,
    gaps: [],
    truncated: false,
  },
  inspectRaw: {
    entries: [{ id: "s:0", line: { kind: "run_stamp" } }],
    annotations: [{ id: "s:0", path: ["payload", "content", 0], label: "thinking" }],
    truncated: false,
    gaps: [],
  },
  inspectSession: { summary: { subject: { kind: "legacy" } }, sessionRuns: [RUN] },
  inspectWork: {
    runs: [],
    empty: {
      reason: "no-data",
      note: "No run has served this work item yet.",
      verb: null,
    },
  },
};
