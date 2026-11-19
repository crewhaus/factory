/**
 * The other ways to do what a console action does, from the operation row Home
 * publishes (`GET /api/v1`): the CLI command in its two forms, the HTTP request,
 * the same request as `curl`, and `crewhaus api`. Pure: no DOM, no request, and
 * no session. A credential never appears in any form; the request names
 * `$CREWHAUS_TOKEN`, which the person sets from their own token.
 *
 *   equivalentsFor(row, params, where) → {cli, http, curl, api} | {none}
 *
 * - `cli.direct`: `cd '<dir>' && crewhaus …`, from the row's `cliTwin`, only where
 *   the view already holds the harness's folder (`where.dir`), and only when the
 *   row has a twin. A row without one carries its reason in `cli.note`.
 * - `cli.remote`: `crewhaus api <operation> --param <name>=<value> … --server
 *   <home-url>`, after `cli.login` (`crewhaus login --server <home-url>`): without
 *   `--server` the CLI talks to the Home on the same computer.
 * - `api`: the same call with no `--server`, on Home's own computer.
 * - `http` and `curl`: the method, the path, `Authorization`, the protocol
 *   header, an `Idempotency-Key` placeholder for a receipted row, and the body.
 *
 * An action with no operation row (a legacy-only action) answers `{none}`.
 */

import { shellQuote, twinSafe } from "../supervision.js";

/** The protocol a request names (`CrewHaus-Protocol`). */
export const PROTOCOL = "crewhaus.hangar.v1";

/** What an action with no public operation answers. */
export const NO_PUBLIC_API = "No public API for this yet.";

/** A value shown in a command: quoted, or its placeholder when missing or unsafe. */
function word(value, placeholder) {
  return typeof value === "string" && value !== "" && twinSafe(value)
    ? shellQuote(value)
    : placeholder;
}

/** The path an operation answers on, with its params; a missing one is its placeholder. */
export function pathOf(row, params = {}) {
  return String(row.path)
    .split("/")
    .map((piece) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      if (name === undefined) return piece;
      const value = params[name];
      if (typeof value !== "string" || value === "" || !twinSafe(value)) return `<${name}>`;
      const parts = name === "ref" ? value.split("/") : [value];
      return parts.map(encodeURIComponent).join("/");
    })
    .join("/");
}

/** The placeholder name in a twin token `{name}`, or null. */
function placeholderOf(token) {
  return /^\{([A-Za-z]+)\}$/.exec(token)?.[1] ?? null;
}

/** The row's twin as a command, its values quoted; null without a twin or a folder. */
function directOf(row, params, dir) {
  if (row.cliTwin === null || typeof row.cliTwin !== "object") return null;
  if (!Array.isArray(row.cliTwin.argv)) return null;
  if (typeof dir !== "string" || dir === "" || !twinSafe(dir)) return null;
  const values = { ...params, dir, ...(params.h !== undefined ? { hrn: params.h } : {}) };
  const words = row.cliTwin.argv.map((token) => {
    const name = placeholderOf(token);
    return name === null ? token : word(values[name], `<${name.toLowerCase()}>`);
  });
  return ["cd", shellQuote(dir), "&&", "crewhaus", ...words].join(" ");
}

/** `crewhaus api <operation>` with its params, query and body, and `--server <word>` when given. */
function apiCall(row, params, query, body, server) {
  const parts = ["crewhaus", "api", row.id];
  for (const [name, value] of Object.entries(params)) {
    if (!String(row.path).includes(`{${name}}`)) continue;
    parts.push("--param", word(`${name}=${value}`, `${name}=<${name}>`));
  }
  for (const [name, value] of Object.entries(query)) {
    parts.push("--query", word(`${name}=${value}`, `${name}=<${name}>`));
  }
  if (body !== undefined) parts.push("--body-file", "<body-file>");
  if (server !== null) parts.push("--server", server);
  return parts.join(" ");
}

/** The query string, encoded, or "". */
function queryString(query) {
  const pairs = Object.entries(query).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
  );
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/**
 * Every equivalent of one call. `row` is the operation row (or null for an action
 * with none); `params` its path params; `where` is `{dir?, homeUrl?, query?, body?}`.
 */
export function equivalentsFor(row, params = {}, where = {}) {
  if (row === null || typeof row !== "object" || typeof row.id !== "string") {
    return { none: NO_PUBLIC_API };
  }
  const w = where !== null && typeof where === "object" ? where : {};
  const p = params !== null && typeof params === "object" ? params : {};
  const query = w.query !== null && typeof w.query === "object" ? w.query : {};
  const body = w.body;
  const homeUrl = typeof w.homeUrl === "string" && w.homeUrl !== "" ? w.homeUrl : null;
  const receipted = typeof row.receipt === "string" && row.receipt !== "none";
  const path = `${pathOf(row, p)}${queryString(query)}`;
  const headers = [
    ["Authorization", "Bearer $CREWHAUS_TOKEN"],
    ["CrewHaus-Protocol", PROTOCOL],
    ...(receipted ? [["Idempotency-Key", "<key>"]] : []),
    ...(body !== undefined ? [["Content-Type", "application/json"]] : []),
  ];
  const bodyText = body === undefined ? null : JSON.stringify(body, null, 2);
  const http = [
    `${row.method} ${path}`,
    ...headers.map(([k, v]) => `${k}: ${v}`),
    ...(bodyText !== null ? ["", bodyText] : []),
  ].join("\n");
  const url = `${homeUrl === null ? "<home-url>" : homeUrl.replace(/\/+$/, "")}${path}`;
  const curl = [
    "curl",
    "-X",
    row.method,
    homeUrl === null ? `<home-url>${path}` : shellQuote(url),
    // The token is the shell's to expand, so this one header is double-quoted.
    "-H",
    '"Authorization: Bearer $CREWHAUS_TOKEN"',
    "-H",
    shellQuote(`CrewHaus-Protocol: ${PROTOCOL}`),
    ...(receipted ? ["-H", "'Idempotency-Key: <key>'"] : []),
    ...(bodyText !== null
      ? [
          "-H",
          shellQuote("Content-Type: application/json"),
          "--data",
          shellQuote(JSON.stringify(body)),
        ]
      : []),
  ].join(" ");
  const direct = directOf(row, p, w.dir);
  return {
    cli: {
      direct,
      remote: apiCall(row, p, query, body, homeUrl === null ? "<home-url>" : shellQuote(homeUrl)),
      login: [
        "crewhaus",
        "login",
        "--server",
        homeUrl === null ? "<home-url>" : shellQuote(homeUrl),
      ].join(" "),
      note: row.cliTwin === null && typeof row.noTwinReason === "string" ? row.noTwinReason : null,
    },
    http,
    curl,
    api: apiCall(row, p, query, body, null),
  };
}
