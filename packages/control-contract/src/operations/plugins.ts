/** The plugin rows of the integrations area (#522): review, grant and revoke. Data only. */
import { READ, WORKSPACE_COMMAND } from "./shared.js";

const PLUGIN = "/api/v1/plugins/{plugin}";

/** Why a grant has no twin: a twin fills one value per placeholder, and a grant is lists. */
export const PLUGIN_GRANT_NO_TWIN =
  "A grant is several lists: `crewhaus plugins grant <name> --harness <id,…> --panes <id,…> --events <family,…> --reads <kind,…> --net <origin,…> --tools <name,…>` does this.";

export const PLUGIN_OPERATIONS = [
  {
    ...READ,
    id: "plugins.review",
    method: "GET",
    path: `${PLUGIN}/review`,
    permission: "home.read",
    request: "noBody",
    response: "pluginReview",
    cliTwin: { argv: ["plugins", "grants", "{plugin}"] },
    qualifiers: ["filtered"],
  },
  {
    ...WORKSPACE_COMMAND,
    id: "plugins.grant",
    method: "PUT",
    path: `${PLUGIN}/grant`,
    permission: "home.settings.manage",
    request: "pluginGrantRequest",
    response: "commandAccepted",
    cliTwin: null,
    noTwinReason: PLUGIN_GRANT_NO_TWIN,
    qualifiers: ["human-only"],
  },
  {
    ...WORKSPACE_COMMAND,
    id: "plugins.revoke",
    method: "POST",
    path: `${PLUGIN}/revoke`,
    permission: "home.settings.manage",
    request: "emptyRequest",
    response: "commandAccepted",
    cliTwin: { argv: ["plugins", "revoke", "{plugin}"] },
    qualifiers: ["human-only"],
  },
] as const;
