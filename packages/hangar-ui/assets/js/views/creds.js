/**
 * Credentials — the per-harness `.env` editor (presence only), the doctor,
 * the secrets backend, and the MCP config lint. Plus the fleet-wide
 * credential matrix and its set-across action.
 *
 * VALUES ARE WRITE-ONLY, and this screen is where that promise is most
 * visible: a field accepts a value and the panel immediately re-reads
 * PRESENCE. Nothing here ever displays a secret, because nothing here ever
 * receives one back — the server returns booleans.
 *
 * "Unset" writes a `# NAME=` stub rather than removing the line, so a
 * required key stays visible instead of quietly disappearing from the
 * checklist.
 *
 * Set-across is the sharpest tool in the manager: one typed value written
 * into several harnesses' own `.env` files, typed-confirm gated, reported
 * per harness, stored nowhere.
 */

import { renderPendingSurface } from "../pending.js";

/** The per-harness Credentials tab. */
export async function renderCreds(root, _ctx) {
  renderPendingSurface(root, {
    group: "creds",
    title: "Credentials",
    blurb:
      "The required-set checklist with set / missing / commented-stub / informational states, the presence-only .env editor, doctor with its auth-vs-billing classification, the secrets backend with rotation, and the MCP config lint.",
  });
}

/** The fleet-wide credentials matrix (`#/credentials`). */
export async function renderCredentialsMatrix(root) {
  renderPendingSurface(root, {
    group: "creds",
    title: "Fleet credentials matrix",
    blurb:
      "Harness × credential-NAME grid (never values), with set-across for filling one key everywhere it is missing.",
  });
}
