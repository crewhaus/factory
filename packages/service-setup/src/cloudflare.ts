/**
 * Cloudflare client for the one thing a harness genuinely cannot do for
 * itself: put a stable, TLS-terminated public hostname in front of a daemon
 * that only ever listens on localhost.
 *
 * WHY A *NAMED* TUNNEL WITH A *REMOTELY MANAGED* CONFIG. A quick tunnel
 * (`cloudflared tunnel --url`) mints a throwaway `*.trycloudflare.com` name
 * that changes on every restart, which is useless for a Slack request URL or
 * a webhook a third party has stored. A named tunnel has a durable id, and its
 * ingress rules can live either in a local `config.yml` beside the connector
 * or in Cloudflare's own store. This module always chooses the store: it is
 * the only variant an API client can edit, so `crewhaus services setup` can
 * add a second harness's hostname to a tunnel it created months ago without
 * anyone SSHing to the box that runs `cloudflared`.
 *
 * That choice has a hard, one-way consequence. `config_src` defaults to
 * `"local"` on create, and `PATCH /cfd_tunnel/{id}` accepts only `name` and
 * `tunnel_secret` — there is no API path that converts a locally-managed
 * tunnel to a remotely-managed one. So `ensureTunnel` refuses to reuse a
 * locally-managed tunnel rather than PUT a configuration the connector will
 * never read.
 *
 * The second trap this module exists to close is that Cloudflare's
 * configuration PUT validates almost nothing. A rule list whose last entry
 * carries a hostname is accepted, `success: true` comes back, and `version`
 * increments — but `cloudflared` fails to deserialize it, logs "The last
 * ingress rule must match all URLs", never advances `currentVersion`, and
 * keeps serving the previous config. A green API response with zero effect is
 * the worst failure mode there is, so `mergeIngress` guarantees exactly one
 * catch-all and puts it last, and `putTunnelConfiguration` re-normalises
 * defensively before anything reaches the wire.
 *
 * Everything here goes through `requestJson`, so the whole surface is
 * exercised in tests with an injected `fetchImpl` and no credentials.
 */
import { type JsonResponse, asRecord, readString, requestJson } from "./http";
import type { ServiceDeps } from "./types";
import { ServiceSetupError } from "./types";

/** Cloudflare's v4 REST root. Overridable per-call via `CloudflareDeps.apiBase`. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * The operator's *provisioning* credential — a scoped API token, never
 * anything the compiled harness runs with. Legacy api_email/api_key global
 * keys are deliberately unsupported: they carry every permission on the
 * account, and this tool needs three.
 */
export type CloudflareAuth = { readonly apiToken: string };

/** Injected seams plus an API root override, for tests and for CF-compatible proxies. */
export type CloudflareDeps = ServiceDeps & { readonly apiBase?: string };

/**
 * The subset of a `cfd_tunnel` record this package acts on. `configSrc` is
 * the load-bearing field — see `ensureTunnel` — and `deletedAt` is carried
 * because Cloudflare tombstones tunnels rather than removing them, and a
 * tombstoned tunnel still answers to a name query.
 */
export type TunnelSummary = {
  readonly id: string;
  readonly name: string;
  readonly configSrc: "cloudflare" | "local";
  readonly deletedAt: string | null;
  /**
   * Whether a connector is currently attached — `"healthy"`, `"degraded"`,
   * `"inactive"`, `"down"`, or `"unknown"` when the API did not say.
   *
   * This is what decides whether the operator still needs the connector
   * command. Keying that off "did THIS run create the tunnel" loses it
   * forever the moment a later step fails: run 1 creates the tunnel, DNS
   * 403s, run 2 reports the tunnel unchanged and never prints the token, and
   * the hostname 502s with nothing to explain why.
   */
  readonly status: string;
};

/**
 * One ingress rule. `service` is an origin URL (`http://localhost:8787`) or a
 * built-in like `http_status:404`.
 *
 * `path` is an UNANCHORED Go regexp, not a glob: `"/api"` also matches
 * `/v2/notapi/x`. Anchor anything you pass (`"^/api"`), or omit it and let the
 * hostname do the routing — which is what the harness flow does.
 *
 * This module never AUTHORS an `originRequest` block. cloudflared's
 * `CustomDuration.UnmarshalJSON` multiplies a numeric duration by
 * `time.Second`, so a value already expressed in nanoseconds overflows int64
 * into a negative timeout and every dial fails (cloudflare/cloudflared#1702).
 * Rather than pick a unit and hope, we emit no timeout fields and let the
 * connector's own defaults stand.
 *
 * It does, however, CARRY one. `extra` holds every field of a rule this
 * module does not model — `originRequest` above all, which is where
 * Cloudflare Access lives (`access: { required: true, teamName, audTag }`).
 * Since `PUT …/configurations` is a full replace, a rule round-tripped
 * without its `extra` comes back stripped: another harness's hostname would
 * silently lose its Access requirement and become publicly reachable through
 * the tunnel, with the API answering `success: true`. Not modelling a field
 * is not a licence to delete it.
 */
export type IngressRule = {
  readonly hostname?: string;
  readonly service: string;
  readonly path?: string;
  /** Fields Cloudflare stored that this module does not model, carried verbatim. */
  readonly extra?: Readonly<Record<string, unknown>>;
};

/**
 * A tunnel's remotely-stored configuration. `version` is Cloudflare's
 * monotonic counter; the connector reports the version it has actually
 * applied, so a `version` that climbs while the tunnel keeps old behaviour is
 * the signature of a rejected (usually catch-all-less) rule list.
 */
export type TunnelConfiguration = {
  readonly version: number;
  readonly ingress: readonly IngressRule[];
  /**
   * The whole stored `config` object, verbatim. A write must spread this and
   * replace only `ingress`, or the full-replace PUT drops the keys this
   * module does not model — `warp-routing` (private network access for the
   * whole account's WARP clients) and the tunnel-level `originRequest`.
   */
  readonly raw: Readonly<Record<string, unknown>>;
};

/** Outcome of the DNS step, so the caller can render created/updated/no-op honestly. */
export type DnsUpsertResult = {
  readonly action: "created" | "updated" | "unchanged";
  readonly recordId: string;
  readonly name: string;
};

/**
 * The mandatory final rule. cloudflared — not the API — enforces that the last
 * rule matches every URL, and a rule matches everything only when it carries
 * neither a hostname nor a path.
 */
const CATCH_ALL_SERVICE = "http_status:404";

/**
 * Printed as the `Fix:` on any 401/403. The `/token` endpoint in particular
 * needs the write-level tunnel group — a read-only tunnel token authenticates
 * fine and then 403s exactly once, at the step that matters.
 */
const TOKEN_SCOPES_FIX =
  "Mint the token at dash.cloudflare.com/profile/api-tokens with all three of " +
  "Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit and Zone · Zone · Read, " +
  "then re-export CLOUDFLARE_API_TOKEN.";

/**
 * Build the ingress origin for a locally-listening daemon.
 *
 * `localhost` IS correct and safe here, and the widespread advice to hard-code
 * `127.0.0.1` "because cloudflared only dials IPv6" is a myth. cloudflared
 * builds a stock `net.Dialer` and leaves `FallbackDelay` at zero, so Go's
 * dual-stack Happy Eyeballs starts the IPv4 attempt the moment `::1` refuses;
 * there has never been a release that dialled IPv6 only. The familiar
 * `dial tcp [::1]:PORT: connect: connection refused` line is simply the last
 * error of the pair — it means BOTH families failed, i.e. nothing is listening
 * — so swapping the host is a placebo that hides a daemon that never started.
 * The name is kept because it is what appears in the operator's own `--port`
 * flag, and matching that makes the rendered plan self-explanatory.
 */
export function localOrigin(port: number, host = "localhost"): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ServiceSetupError("cloudflare", `invalid origin port: ${port}`, {
      fix: "Pass the port the harness daemon listens on, an integer in 1–65535.",
    });
  }
  return `http://${host}:${port}`;
}

/**
 * Confirm the token is live before anything is created. This is the cheapest
 * possible first call, and it turns "403 halfway through provisioning, with a
 * tunnel already created" into "nothing happened, fix the token".
 */
export async function verifyToken(
  auth: CloudflareAuth,
  deps: CloudflareDeps = {},
): Promise<{ id: string; status: string }> {
  const res = await call(auth, deps, { path: "/user/tokens/verify" });
  const result = asRecord(unwrap(res, "Cloudflare token verification failed", TOKEN_SCOPES_FIX));
  const id = readString(result, "id") ?? "";
  const status = readString(result, "status") ?? "unknown";
  if (status !== "active") {
    throw new ServiceSetupError("cloudflare", `Cloudflare API token is ${status}, not active`, {
      status: res.status,
      code: status,
      fix: "Re-enable or re-create the token at dash.cloudflare.com/profile/api-tokens.",
    });
  }
  return { id, status };
}

/**
 * Resolve a zone name to its zone id and owning account id.
 *
 * This is also how the account id is discovered, in preference to
 * `GET /accounts`: that endpoint declares only api_email/api_key security in
 * Cloudflare's published OpenAPI and can reject a scoped bearer token, which
 * would force operators to paste an account id by hand for no reason. The zone
 * record carries `account.id`, and the flow already needs the zone.
 */
export async function findZone(
  auth: CloudflareAuth,
  zoneName: string,
  deps: CloudflareDeps = {},
): Promise<{ zoneId: string; accountId: string }> {
  const query = new URLSearchParams({ name: zoneName });
  const res = await call(auth, deps, { path: `/zones?${query.toString()}` });
  const list = asArray(
    unwrap(
      res,
      `Cloudflare zone lookup for "${zoneName}" failed`,
      "Confirm the zone name is the apex domain (example.com, not www.example.com).",
    ),
  );
  const first = list[0];
  const zoneId = first === undefined ? undefined : readString(first, "id");
  const accountId = first === undefined ? undefined : readString(asRecord(first)["account"], "id");
  if (zoneId === undefined || accountId === undefined) {
    const fix = [
      `Add ${zoneName} to Cloudflare (or fix the spelling), and make sure the token's`,
      "Zone · Zone · Read grant covers it — a zone-scoped token cannot see other zones.",
    ].join(" ");
    throw new ServiceSetupError("cloudflare", `no zone named "${zoneName}" on this account`, {
      status: res.status,
      fix,
    });
  }
  return { zoneId, accountId };
}

/**
 * Look up a tunnel by exact name. Returns `undefined` when there is none to
 * reuse.
 *
 * `is_deleted=false` is sent AND the result is filtered on `deleted_at`:
 * deleted tunnels are tombstones that keep their name, and reusing one yields
 * a tunnel that can never connect. Belt and braces is cheap here because the
 * failure is silent.
 */
export async function findTunnelByName(
  auth: CloudflareAuth,
  accountId: string,
  name: string,
  deps: CloudflareDeps = {},
): Promise<TunnelSummary | undefined> {
  const query = new URLSearchParams({ name, is_deleted: "false" });
  const res = await call(auth, deps, {
    path: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?${query.toString()}`,
  });
  const list = asArray(
    unwrap(
      res,
      `Cloudflare tunnel lookup for "${name}" failed`,
      "Check the account id and that the token carries Account · Cloudflare Tunnel · Edit.",
    ),
  );
  for (const entry of list) {
    const tunnel = toTunnelSummary(entry);
    if (tunnel !== undefined && tunnel.name === name && tunnel.deletedAt === null) return tunnel;
  }
  return undefined;
}

/**
 * Create a named, remotely-managed tunnel.
 *
 * `config_src: "cloudflare"` is passed EXPLICITLY because the field defaults
 * to `"local"`. Omitting it produces a tunnel that looks identical in the
 * dashboard and accepts every configuration PUT with `success: true`, while
 * the connector reads its rules from a `config.yml` nobody wrote — so the
 * hostname 502s forever with no error anywhere in the API transcript.
 *
 * `tunnel_secret` is deliberately not sent: letting Cloudflare generate it
 * means this process never holds the secret, and the connector credential is
 * fetched separately by `getTunnelToken`.
 */
export async function createTunnel(
  auth: CloudflareAuth,
  accountId: string,
  name: string,
  deps: CloudflareDeps = {},
): Promise<TunnelSummary> {
  const res = await call(auth, deps, {
    path: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
    method: "POST",
    json: { name, config_src: "cloudflare" },
  });
  const result = unwrap(
    res,
    `Cloudflare tunnel "${name}" could not be created`,
    "The token needs Account · Cloudflare Tunnel · Edit on this account.",
  );
  const tunnel = toTunnelSummary(result);
  if (tunnel === undefined) {
    throw new ServiceSetupError("cloudflare", `unexpected create-tunnel response for "${name}"`, {
      status: res.status,
      fix: "Re-run setup; if it repeats, check status.cloudflarestatus.com before retrying.",
    });
  }
  return tunnel;
}

/**
 * Find-or-create, with the one assertion that makes the rest of this module
 * safe: a REUSED tunnel must already be remotely managed.
 *
 * There is no API to migrate `config_src` — `PATCH /cfd_tunnel/{id}` takes
 * only `name` and `tunnel_secret` — so a locally-managed tunnel is a dead end
 * we must refuse loudly rather than paper over. Failing here costs the
 * operator one decision; failing silently costs them an afternoon staring at a
 * 502 whose entire API trail says `success: true`.
 */
export async function ensureTunnel(
  auth: CloudflareAuth,
  accountId: string,
  name: string,
  deps: CloudflareDeps = {},
): Promise<{ tunnel: TunnelSummary; created: boolean }> {
  const existing = await findTunnelByName(auth, accountId, name, deps);
  if (existing !== undefined) {
    if (existing.configSrc !== "cloudflare") {
      const message = [
        `tunnel "${name}" (${existing.id}) is locally managed (config_src: "local"),`,
        "so ingress rules written through the API would be ignored",
      ].join(" ");
      const fix = [
        "Either delete and re-create the tunnel as remotely managed (crewhaus will do that",
        `if you remove "${name}" in Zero Trust → Networks → Tunnels), or keep managing it`,
        "in the connector's own config.yml and add the ingress rule there.",
      ].join(" ");
      throw new ServiceSetupError("cloudflare", message, { code: "config_src_local", fix });
    }
    return { tunnel: existing, created: false };
  }

  const created = await createTunnel(auth, accountId, name, deps);
  if (created.configSrc !== "cloudflare") {
    throw new ServiceSetupError(
      "cloudflare",
      `Cloudflare created tunnel "${name}" as locally managed despite config_src: "cloudflare"`,
      {
        code: "config_src_local",
        fix: "Delete the tunnel in Zero Trust → Networks → Tunnels and re-run setup.",
      },
    );
  }
  return { tunnel: created, created: true };
}

/**
 * Fetch the connector token — the credential `cloudflared` runs with.
 *
 * `result` here is a BARE STRING, not an object; every other endpoint in this
 * file returns a record, so the shape is asserted rather than assumed. The
 * create response's `token`/`credentials_file` fields appear in Cloudflare's
 * written guide but in neither the published OpenAPI schema nor every account
 * tier's actual response, so this module never reads them and always asks the
 * dedicated endpoint.
 *
 * The return value is a live credential: hand it to the operator, never to a
 * log sink.
 */
export async function getTunnelToken(
  auth: CloudflareAuth,
  accountId: string,
  tunnelId: string,
  deps: CloudflareDeps = {},
): Promise<string> {
  const res = await call(auth, deps, {
    path: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(
      tunnelId,
    )}/token`,
  });
  const result = unwrap(res, "Cloudflare connector token could not be fetched", TOKEN_SCOPES_FIX);
  if (typeof result !== "string" || result === "") {
    throw new ServiceSetupError("cloudflare", "Cloudflare returned an empty connector token", {
      status: res.status,
      fix:
        "This endpoint needs the write-level Account · Cloudflare Tunnel · Edit group; a " +
        "read-only tunnel token can list tunnels but never fetch their token.",
    });
  }
  return result;
}

/**
 * Read the tunnel's remotely-stored configuration, which is step one of the
 * only safe write sequence: GET → merge → PUT.
 *
 * A never-configured tunnel answers with an empty or absent `config`, which
 * this treats as "no rules yet" rather than an error — that is the normal
 * state immediately after `createTunnel`.
 */
export async function getTunnelConfiguration(
  auth: CloudflareAuth,
  accountId: string,
  tunnelId: string,
  deps: CloudflareDeps = {},
): Promise<TunnelConfiguration> {
  const res = await call(auth, deps, {
    path: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(
      tunnelId,
    )}/configurations`,
  });
  const result = asRecord(
    unwrap(
      res,
      "Cloudflare tunnel configuration could not be read",
      "Confirm the tunnel id, and that the token carries Account · Cloudflare Tunnel · Edit.",
    ),
  );
  const config = asRecord(result["config"]);
  const ingress: IngressRule[] = [];
  for (const entry of asArray(config["ingress"])) {
    const rule = toIngressRule(entry);
    if (rule !== undefined) ingress.push(rule);
  }
  return { version: readNumber(result, "version") ?? 0, ingress, raw: config };
}

/**
 * PURE. Hostname-keyed upsert of `desired` into `existing`.
 *
 * This is the whole reason the flow is GET → merge → PUT: the configuration
 * endpoint is a confirmed FULL REPLACE ("Replaces the configuration … including
 * its ingress rules and origin request settings") with no PATCH counterpart,
 * so PUTting only this harness's rule would silently unpublish every other
 * hostname on the tunnel.
 *
 * The contract:
 *  - a desired rule REPLACES the first existing rule with the same hostname,
 *    in place, so unrelated rules keep their relative order (order is
 *    significant — cloudflared matches top-down and takes the first hit);
 *  - a hostname not already present is APPENDED, before the catch-all;
 *  - hostname-less rules are fallbacks, never routes: they are pulled out,
 *    the last one wins (a desired fallback outranking an existing one), and it
 *    is emitted stripped of `path` — a path stops it matching all URLs;
 *  - if no fallback exists, `http_status:404` is synthesised.
 *
 * The result therefore always ends with exactly one catch-all. That invariant
 * is not cosmetic: the API accepts a hostname-terminated list with
 * `success: true`, and only the connector rejects it — at which point the
 * tunnel keeps serving its previous configuration and nothing in the API
 * transcript says so.
 */
export function mergeIngress(
  existing: readonly IngressRule[],
  desired: readonly IngressRule[],
): IngressRule[] {
  const desiredByRoute = new Map<string, IngressRule>();
  const desiredOrder: string[] = [];
  const fallbacks: IngressRule[] = [];

  for (const rule of desired) {
    if (rule.hostname === undefined) {
      fallbacks.push(rule);
      continue;
    }
    const key = routeKey(rule);
    if (!desiredByRoute.has(key)) desiredOrder.push(key);
    desiredByRoute.set(key, rule);
  }

  const merged: IngressRule[] = [];
  const replaced = new Set<string>();
  const existingFallbacks: IngressRule[] = [];
  for (const rule of existing) {
    if (rule.hostname === undefined) {
      existingFallbacks.push(rule);
      continue;
    }
    const key = routeKey(rule);
    const override = desiredByRoute.get(key);
    if (override === undefined) {
      // A DIFFERENT route on the same hostname — `{host, path: "^/metrics"}`
      // beside a bare `{host}` — is a normal two-route config, not a stale
      // duplicate: cloudflared matches on hostname AND path, top-down. Keep
      // it, and keep it in place, because first-match makes order semantic.
      merged.push(rule);
      continue;
    }
    if (replaced.has(key)) continue;
    replaced.add(key);
    // Preserve the existing rule's unmodelled fields under the new service,
    // so re-pointing an origin does not strip its Access config.
    merged.push(rule.extra === undefined ? override : { ...override, extra: rule.extra });
  }

  for (const key of desiredOrder) {
    if (replaced.has(key)) continue;
    const rule = desiredByRoute.get(key);
    if (rule !== undefined) merged.push(rule);
  }

  const fallback = [...existingFallbacks, ...fallbacks].at(-1);
  merged.push(
    fallback === undefined
      ? { service: CATCH_ALL_SERVICE }
      : // Keep the operator's own catch-all, including its `extra`, but never
        // its hostname/path — a filtered last rule is what cloudflared rejects.
        {
          service: fallback.service,
          ...(fallback.extra === undefined ? {} : { extra: fallback.extra }),
        },
  );
  return merged;
}

/**
 * The identity of an ingress route: hostname AND path.
 *
 * Keying on hostname alone was a real bug — it treated
 * `{host, path: "^/api"}` and `{host}` as the same rule and dropped one of
 * them, silently re-routing a path an operator had configured by hand.
 * cloudflared matches (hostname, path) top-down, so both are live routes.
 */
function routeKey(rule: IngressRule): string {
  return `${rule.hostname ?? ""}\n${rule.path ?? ""}`;
}

/**
 * Replace the tunnel's configuration with `ingress`.
 *
 * The list is re-run through `mergeIngress` first. That is not paranoia about
 * our own callers so much as about the one API behaviour we cannot detect
 * afterwards: a malformed list returns 200 with a bumped `version`, so there
 * is no post-hoc check that would catch it. Normalising on the way out is the
 * only place the guarantee can be made.
 *
 * `base` is the `config` object this tunnel was last read with, and passing
 * it is not optional in spirit: the endpoint replaces the WHOLE config, so a
 * write that sends only `ingress` silently drops `warp-routing` and the
 * tunnel-level `originRequest`. Everything in `base` is spread through and
 * only `ingress` is replaced. It defaults to `{}` so a caller provisioning a
 * brand-new tunnel need not invent one.
 */
export async function putTunnelConfiguration(
  auth: CloudflareAuth,
  accountId: string,
  tunnelId: string,
  ingress: readonly IngressRule[],
  deps: CloudflareDeps = {},
  base: Readonly<Record<string, unknown>> = {},
): Promise<{ version: number }> {
  const normalized = mergeIngress(ingress, []);
  const res = await call(auth, deps, {
    path: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(
      tunnelId,
    )}/configurations`,
    method: "PUT",
    json: { config: { ...base, ingress: normalized.map(toWireRule) } },
  });
  const result = asRecord(
    unwrap(
      res,
      "Cloudflare tunnel configuration could not be written",
      "The token needs Account · Cloudflare Tunnel · Edit; a read grant cannot PUT config.",
    ),
  );
  return { version: readNumber(result, "version") ?? 0 };
}

/**
 * Point `fqdn` at the tunnel, idempotently.
 *
 * Idempotency is achieved by READING first, not by catching a duplicate-record
 * error. The codes usually cited for that (81053/81057) are community folklore
 * — they appear in neither Cloudflare's OpenAPI schema nor its documentation —
 * so branching on them would be branching on a string we cannot verify and
 * that costs a real record if it ever changes.
 *
 * `proxied: true` is what makes the CNAME resolve to Cloudflare's edge (a
 * grey-clouded `*.cfargotunnel.com` record resolves to nothing). It also
 * forces automatic TTL, which is why no `ttl` is sent: any value other than 1
 * is rejected for a proxied record.
 */
export async function upsertDnsCname(
  auth: CloudflareAuth,
  zoneId: string,
  fqdn: string,
  tunnelId: string,
  deps: CloudflareDeps = {},
): Promise<DnsUpsertResult> {
  const content = `${tunnelId}.cfargotunnel.com`;
  const query = new URLSearchParams({ type: "CNAME", name: fqdn });
  const listRes = await call(auth, deps, {
    path: `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`,
  });
  const list = asArray(
    unwrap(
      listRes,
      `Cloudflare DNS lookup for ${fqdn} failed`,
      "The token needs Zone · DNS · Edit on the zone that owns this hostname.",
    ),
  );

  const wanted = fqdn.toLowerCase();
  const found = list
    .map(asRecord)
    .find((record) => (readString(record, "name") ?? "").toLowerCase() === wanted);

  if (found === undefined) {
    const createRes = await call(auth, deps, {
      path: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      method: "POST",
      json: { type: "CNAME", name: fqdn, content, proxied: true },
    });
    const created = asRecord(
      unwrap(
        createRes,
        `Cloudflare DNS record ${fqdn} could not be created`,
        "The token needs Zone · DNS · Edit; also check the hostname is inside this zone.",
      ),
    );
    return { action: "created", recordId: readString(created, "id") ?? "", name: fqdn };
  }

  const recordId = readString(found, "id") ?? "";
  if (readString(found, "content") === content && found["proxied"] === true) {
    return { action: "unchanged", recordId, name: fqdn };
  }

  const patchRes = await call(auth, deps, {
    path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    method: "PATCH",
    json: { type: "CNAME", name: fqdn, content, proxied: true },
  });
  const updated = asRecord(
    unwrap(
      patchRes,
      `Cloudflare DNS record ${fqdn} could not be updated`,
      `Delete the existing ${fqdn} record by hand if it is locked, then re-run setup.`,
    ),
  );
  return { action: "updated", recordId: readString(updated, "id") ?? recordId, name: fqdn };
}

/**
 * The connector command the operator must run. This tool never shells out to
 * `sudo` on their behalf — installing a system service is a decision, and a
 * provisioner that silently registers a launchd/systemd unit is one nobody can
 * audit after the fact.
 *
 * CALLERS MUST NOT LOG THE RESULT. The token is embedded because the operator
 * has to paste a working command, but it is a live credential: print it to the
 * terminal, never into a log file, a CI transcript, or an issue report.
 */
export function connectorInstallHint(token: string): readonly string[] {
  return [
    "Run the connector on the machine hosting the daemon.",
    "The command below contains a live credential — do not paste it into logs or issues.",
    "",
    "Install it as a service (launchd/systemd, survives reboot):",
    `  sudo cloudflared service install ${token}`,
    "",
    "Or run it in the foreground to try it out (Ctrl-C stops it):",
    `  cloudflared tunnel run --token ${token}`,
  ];
}

/** Resolve the API root, tolerating a trailing slash in an override. */
function apiBase(deps: CloudflareDeps): string {
  return (deps.apiBase ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
}

/** One authenticated Cloudflare call. Never throws on a non-2xx — `unwrap` classifies. */
async function call(
  auth: CloudflareAuth,
  deps: CloudflareDeps,
  req: {
    readonly path: string;
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly json?: unknown;
  },
): Promise<JsonResponse> {
  return requestJson(
    {
      url: `${apiBase(deps)}${req.path}`,
      method: req.method ?? (req.json === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${auth.apiToken}` },
      ...(req.json === undefined ? {} : { json: req.json }),
    },
    deps,
  );
}

/**
 * Unwrap Cloudflare's uniform envelope
 * (`{ success, errors, messages, result }`) or throw a classified error.
 *
 * A 200 is not enough: `success: false` with a 200 is rare but real, so both
 * are required. `fix` is mandatory at every call site — an operator-facing
 * failure without a next step is a bug — except that any 401/403 is overridden
 * with the permissions text, because at that point the scopes are the only
 * plausible cause.
 */
function unwrap(res: JsonResponse, action: string, fix: string): unknown {
  const body = asRecord(res.body);
  if (res.ok && body["success"] === true) return body["result"];

  const details = describeErrors(body["errors"]);
  const message = details.length > 0 ? details.join("; ") : `HTTP ${res.status}`;
  const code = firstErrorCode(body["errors"]);
  const isAuthFailure = res.status === 401 || res.status === 403;
  throw new ServiceSetupError("cloudflare", `${action}: ${message}`, {
    status: res.status,
    ...(code === undefined ? {} : { code }),
    fix: isAuthFailure ? TOKEN_SCOPES_FIX : fix,
  });
}

/**
 * Render Cloudflare's error array into one line, following `error_chain`.
 *
 * The chain is where the actionable detail usually lives — the outer entry is
 * often a generic "An unknown error occurred" while the nested one names the
 * conflicting record — even though `error_chain` is absent from the published
 * schema. It is therefore parsed optionally and defensively, with a depth cap
 * so a pathological body cannot recurse without bound.
 */
function describeErrors(value: unknown, depth = 0): string[] {
  if (!Array.isArray(value) || depth > 4) return [];
  const out: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const message = readString(record, "message") ?? "";
    const code = errorCode(record);
    const label = code === undefined ? message : `${code}: ${message}`;
    if (label !== "") out.push(label);
    for (const nested of describeErrors(record["error_chain"], depth + 1)) {
      out.push(`→ ${nested}`);
    }
  }
  return out;
}

/** Cloudflare error codes are numeric on the wire; normalise to a string for `code`. */
function errorCode(record: Readonly<Record<string, unknown>>): string | undefined {
  const raw = record["code"];
  if (typeof raw === "number") return String(raw);
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The first code in the envelope, used for `ServiceSetupError.failureClass`. */
function firstErrorCode(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const code = errorCode(asRecord(entry));
    if (code !== undefined) return code;
  }
  return undefined;
}

/** Narrow an unknown to an array without `any`; a non-array is an empty list. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a finite number field off an unknown body. */
function readNumber(value: unknown, key: string): number | undefined {
  const raw = asRecord(value)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Parse one `cfd_tunnel` record; `undefined` when it lacks the fields we key on. */
function toTunnelSummary(value: unknown): TunnelSummary | undefined {
  const record = asRecord(value);
  const id = readString(record, "id");
  const name = readString(record, "name");
  if (id === undefined || name === undefined) return undefined;
  const deletedAt = record["deleted_at"];
  return {
    id,
    name,
    // Anything that is not literally "cloudflare" is locally managed — which
    // includes the field being absent, since "local" is the API's own default.
    configSrc: readString(record, "config_src") === "cloudflare" ? "cloudflare" : "local",
    deletedAt: typeof deletedAt === "string" ? deletedAt : null,
    // `conns`/`connections` is the authoritative signal; `status` is the
    // rendered form. Prefer status, fall back to counting live connections.
    status:
      readString(record, "status") ??
      (asArray(record["connections"]).length > 0 ? "healthy" : "inactive"),
  };
}

/**
 * True when no connector is attached, so the operator still has to run one.
 *
 * A tunnel with no connector resolves and then 502s — the failure that looks
 * like a broken app rather than a missing process, which is why setup always
 * re-offers the command rather than assuming a previous run printed it.
 */
export function needsConnector(tunnel: TunnelSummary): boolean {
  return tunnel.status !== "healthy" && tunnel.status !== "degraded";
}

/** Parse one stored ingress rule; a rule without a `service` is not routable. */
function toIngressRule(value: unknown): IngressRule | undefined {
  const record = asRecord(value);
  const service = readString(record, "service");
  if (service === undefined) return undefined;
  const hostname = readString(record, "hostname");
  const path = readString(record, "path");
  // Everything else the rule carried — `originRequest` most importantly.
  // Keeping it is what makes the full-replace PUT non-destructive.
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "hostname" && key !== "service" && key !== "path") extra[key] = value;
  }
  return {
    ...(hostname === undefined ? {} : { hostname }),
    service,
    ...(path === undefined ? {} : { path }),
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

/**
 * Serialise a rule for the wire: the fields this module models, plus whatever
 * `extra` it was read with. The spread comes FIRST so a modelled field always
 * wins over a stale copy in `extra`.
 */
function toWireRule(rule: IngressRule): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...(rule.extra ?? {}) };
  if (rule.hostname !== undefined) wire["hostname"] = rule.hostname;
  if (rule.path !== undefined) wire["path"] = rule.path;
  wire["service"] = rule.service;
  return wire;
}
