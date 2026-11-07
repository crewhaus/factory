import { HARNESS_COMMAND, READ } from "./shared.js";

const NO_DEPLOYMENT_VERB = "`crewhaus deploy` moves spec-registry pins, not deployment records.";

export const DEPLOYMENT_OPERATIONS = [
  {
    ...READ,
    id: "deployments.list",
    method: "GET",
    path: "/api/v1/harnesses/{h}/deployments",
    permission: "h.read",
    request: "listQuery",
    response: "deploymentList",
    cliTwin: null,
    noTwinReason: NO_DEPLOYMENT_VERB,
    qualifiers: [],
  },
  {
    ...READ,
    id: "deployments.get",
    method: "GET",
    path: "/api/v1/harnesses/{h}/deployments/{dep}",
    permission: "h.read",
    request: "noBody",
    response: "deployment",
    cliTwin: null,
    noTwinReason: NO_DEPLOYMENT_VERB,
    qualifiers: [],
  },
  {
    ...HARNESS_COMMAND,
    id: "deployments.activate",
    method: "POST",
    path: "/api/v1/harnesses/{h}/deployments",
    permission: "h.deploy",
    request: "deploymentActivateRequest",
    cliTwin: null,
    noTwinReason: NO_DEPLOYMENT_VERB,
    qualifiers: ["human-only"],
  },
] as const;
