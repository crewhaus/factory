/** One minimal valid value per integrations schema. */
const HRN = "hrn_0123456789abcdef";

const SET = {
  harnesses: [HRN],
  panes: ["board"],
  events: ["run"],
  reads: ["run.lifecycle"],
  net: ["https://api.example.com"],
  tools: ["Read"],
} as const;

export const EXAMPLES = {
  pluginGrantRequest: { ...SET, expect: 1 },
  pluginReview: {
    plugin: "notes-pane",
    version: "1.0.0",
    entrypointDigest: "a".repeat(64),
    signed: true,
    crewhausRange: "^0.9.0",
    state: "allowed",
    legacy: false,
    asks: SET,
    granted: SET,
    served: SET,
    gen: 1,
    envNames: ["NOTES_API_KEY"],
    verb: "crewhaus plugins grants notes-pane",
  },
};
