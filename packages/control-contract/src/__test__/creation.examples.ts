/** One minimal valid value per creation schema. */
export const EXAMPLES = {
  specSchemaView: {
    harness: "hrn_0123456789abcdef",
    present: true,
    note: null,
    verb: "crewhaus init",
    specName: "support",
    target: "cli",
    schema: { $ref: "#/definitions/cli", definitions: { cli: { type: "object" } } },
    schemaSource: "manager",
    schemaVersion: null,
    schemaNote: null,
    effective: [
      {
        path: "agent.max_tokens",
        segments: ["agent", "max_tokens"],
        value: 4096,
        source: "declared",
      },
    ],
    effectiveTruncated: false,
    effectiveNote: null,
    declaredCount: 1,
    defaultedCount: 0,
    issues: [],
    rev: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    readOnly: null,
    truncated: false,
  },
};
