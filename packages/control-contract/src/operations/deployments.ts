import { HARNESS_COMMAND, READ, TWINS } from "./shared.js";

const ONE_DEPLOYMENT_VERB =
  "`crewhaus deploy list` shows every deployment; the CLI has no verb for one.";

export const DEPLOYMENT_OPERATIONS = [
  {
    ...READ,
    id: "deployments.list",
    method: "GET",
    path: "/api/v1/harnesses/{h}/deployments",
    permission: "h.read",
    request: "listQuery",
    response: "deploymentList",
    cliTwin: TWINS.deployList,
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
    noTwinReason: ONE_DEPLOYMENT_VERB,
    qualifiers: [],
  },
  {
    ...HARNESS_COMMAND,
    id: "deployments.activate",
    method: "POST",
    path: "/api/v1/harnesses/{h}/deployments",
    permission: "h.deploy",
    request: "deploymentActivateRequest",
    cliTwin: TWINS.deployActivate,
    qualifiers: ["human-only"],
  },
] as const;
