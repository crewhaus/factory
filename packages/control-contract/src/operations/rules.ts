import { HARNESS_COMMAND, NOT_MODEL_BOUND, READ, TWINS } from "./shared.js";

export const RULE_OPERATIONS = [
  {
    ...READ,
    id: "rules.list",
    method: "GET",
    path: "/api/v1/harnesses/{h}/standing-rules",
    permission: "h.read",
    request: "listQuery",
    response: "ruleList",
    cliTwin: TWINS.approvalsRules,
    qualifiers: [],
  },
  {
    ...HARNESS_COMMAND,
    id: "rules.create",
    method: "POST",
    path: "/api/v1/harnesses/{h}/standing-rules",
    permission: "h.standing-rule.manage",
    request: "ruleCreateRequest",
    cliTwin: null,
    noTwinReason:
      "A standing rule is made from a decision: `crewhaus approvals grant <id> --always`.",
    qualifiers: ["human-only"],
    modelBound: {
      tool: NOT_MODEL_BOUND.matched,
      pattern: NOT_MODEL_BOUND.matched,
      reason: NOT_MODEL_BOUND.note,
    },
  },
  {
    ...HARNESS_COMMAND,
    id: "rules.revoke",
    method: "POST",
    path: "/api/v1/harnesses/{h}/standing-rules/{rule}/revoke",
    permission: "h.standing-rule.manage",
    request: "emptyRequest",
    cliTwin: TWINS.approvalsRevoke,
    qualifiers: ["human-only"],
  },
] as const;
