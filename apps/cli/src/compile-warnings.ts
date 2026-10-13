/**
 * Compile warning codes that print but never fail `crewhaus compile --strict`.
 *
 * Kept in its own module so the `--strict` filter and the `compile --help`
 * text read the same list (index.ts runs the CLI when imported, so a test
 * cannot reach a constant defined there).
 */

// channel-plugins-at-start is informational: it describes how a
// channel daemon treats its plugins, and a 0.7.0 spec that passed --strict
// must keep passing it.
//
// D40 — channel-reactions-join is INFORMATIONAL: it fires on a fully
// wired, correctly configured feature (the outbound-ts join file just has
// to accumulate at runtime), so no spec edit can ever clear it. Escalating
// it would make --strict permanently unusable for every reactions-enabled
// channel spec; it still prints above, but only remediable codes
// (accepted-but-unwired, edge-unsafe-tool) escalate.
//
// Item 1 — cli-autodistill-toolchain is informational for the same reason:
// `feedback.autoDistill` is honoured by `crewhaus run`, so the only "fix"
// would be deleting a working spec key. The heads-up says which half of the
// block a compiled bundle carries; it must never fail a strict compile.
//
// 0.6.0 — four model-plan codes are informational for the same reason:
// model-plan-candidate-only fires on a `models:` profile field that a
// model_pool CANDIDATE serves and a single-model slot does not (§4.2), so
// the spec is legal and the "fix" — moving the profile into a pool — is a
// topology change, not a defect repair; model-capabilities-unknown fires on
// any model the offline table does not know (a local / new model is not a spec defect);
// model-strongest-crosses-provider is a heads-up about a second credential,
// not a defect; and model-sunset is a wall-clock notice that would make a
// 0.5.x pool that compiled under --strict yesterday fail today (past
// `retiresOn` a `models:` profile is already a hard error at lower time).
//
// 0.7.1 — mcp-server-name is informational for the same reason as
// model-sunset: the key ran on 0.7.0, and a spec that compiled under
// --strict before the upgrade must still compile after it. So is
// model-plan-tool-config-widens: a pool candidate's tool_config REPLACES
// the agent-level block by design, the wider list may be intended, and the
// same spec compiled under --strict on 0.7.0.
// model-plan-tool-config-narrowed is its counterpart for the chain readers
// and FederationDiscover, whose candidate list narrows the agent's: an
// origin only the candidate lists is never reached, which is harmless.
// model-plan-tool-config-unreachable is NOT informational — a candidate
// whose list keeps no origin refuses every call it makes.
//
// 0.7.1 — provider-tool-cap and provider-tool-cap-unverified are
// informational for that reason too. A fallback, tier or pool model over
// its provider's tool limit sat beside a model that serves, and the spec
// passed --strict on 0.7.0; an `openai/` model may be sent by
// OPENAI_BASE_URL to a server with no such limit, which only the running
// process can see (it checks again at start). A site no model can serve is
// still a compile error.
//
// permission-rule-note: a glob such as `*write*` that still fires on a
// declared MCP server's tools is not dead, it merely misses a builtin.
export const INFORMATIONAL_COMPILE_WARNING_CODES: readonly string[] = [
  "channel-reactions-join",
  "channel-plugins-at-start",
  "cli-autodistill-toolchain",
  "mcp-server-name",
  "provider-tool-cap",
  "provider-tool-cap-unverified",
  "permission-rule-note",
  "model-plan-candidate-only",
  "model-plan-tool-config-widens",
  "model-plan-tool-config-narrowed",
  "model-capabilities-unknown",
  "model-strongest-crosses-provider",
  "model-sunset",
];

/** Lays codes out comma-separated, one help line per ~72 columns. */
export function wrapCodes(codes: readonly string[], indent: string, width = 72): string {
  const lines: string[] = [];
  let line = "";
  codes.forEach((code, i) => {
    const word = i < codes.length - 1 ? `${code},` : `${code}.`;
    if (line !== "" && indent.length + line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  });
  if (line !== "") lines.push(line);
  return lines.map((l) => `${indent}${l}\n`).join("");
}
