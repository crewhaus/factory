import { NO_VERB, READ } from "./shared.js";

export const COMMAND_OPERATIONS = [
  {
    ...READ,
    id: "commands.get",
    method: "GET",
    path: "/api/v1/commands/{cmd}",
    permission: "h.read",
    request: "noBody",
    response: "commandReceipt",
    cliTwin: null,
    noTwinReason: NO_VERB,
    qualifiers: ["workspace-target"],
  },
  {
    ...READ,
    id: "commands.list",
    method: "GET",
    path: "/api/v1/harnesses/{h}/commands",
    permission: "h.read",
    request: "listQuery",
    response: "commandList",
    cliTwin: null,
    noTwinReason: NO_VERB,
    qualifiers: [],
  },
] as const;
