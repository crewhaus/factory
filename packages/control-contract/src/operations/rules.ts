import { HARNESS_COMMAND, NO_VERB, READ } from "./shared.js";

export const RULE_OPERATIONS = [
  {
    ...READ,
    id: "rules.list",
    method: "GET",
    path: "/api/v1/harnesses/{h}/standing-rules",
    permission: "h.read",
    request: "listQuery",
    response: "ruleList",
    cliTwin: null,
    noTwinReason: NO_VERB,
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
    noTwinReason: NO_VERB,
    qualifiers: ["human-only"],
  },
  {
    ...HARNESS_COMMAND,
    id: "rules.revoke",
    method: "POST",
    path: "/api/v1/harnesses/{h}/standing-rules/{rule}/revoke",
    permission: "h.standing-rule.manage",
    request: "emptyRequest",
    cliTwin: null,
    noTwinReason: NO_VERB,
    qualifiers: ["human-only"],
  },
] as const;
