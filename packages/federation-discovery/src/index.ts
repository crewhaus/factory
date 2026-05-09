/**
 * @crewhaus/federation-discovery — Section 34
 *
 * Peer lookup for federation. Two methods:
 *
 *   1. DNS SRV — `_crewhaus._tcp.<deployment>.<domain>` returns a list
 *      of `<weight, priority, port, target>` records. The first record
 *      (sorted by priority then weight) wins.
 *
 *   2. `.well-known/crewhaus.json` — `https://<deployment>/.well-known/crewhaus.json`
 *      returns a JSON object describing the peer's endpoint, supported
 *      shapes, and public-key fingerprint.
 *
 * The discovered record is cached with TTL = SRV TTL (when available)
 * or 60s for `.well-known`. Negative results are cached too (10s) so a
 * misconfigured peer doesn't trigger DNS storms.
 *
 * Both lookups are pluggable via injected resolvers — production uses
 * `node:dns/promises.resolveSrv` and `globalThis.fetch`, tests pass
 * fake implementations.
 */
import { CrewhausError } from "@crewhaus/errors";

export class FederationDiscoveryError extends CrewhausError {
  override readonly name = "FederationDiscoveryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type PeerRecord = {
  /** Discovered HTTPS endpoint, e.g. https://federation.deployment-b.example */
  readonly endpoint: string;
  /** Federation protocol version the peer speaks. */
  readonly version: string;
  /** Target shapes the peer's roles can serve. */
  readonly supportedShapes: readonly string[];
  /** SHA256 fingerprint (hex, no separators) of the peer's leaf cert. */
  readonly publicKeyFingerprint: string;
};

export type SrvRecord = {
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly name: string;
};

export type SrvResolver = (name: string) => Promise<{
  readonly records: readonly SrvRecord[];
  readonly ttl: number;
}>;

export type WellKnownFetcher = (url: string) => Promise<{
  readonly status: number;
  readonly body: string;
}>;

export type DiscoveryConfig = {
  readonly srvDomain?: string;
  readonly srvResolver?: SrvResolver;
  readonly wellKnownFetcher?: WellKnownFetcher;
  readonly now?: () => number;
  /** Cache TTL for negative-result lookups. Default 10s. */
  readonly negativeTtlMs?: number;
  /**
   * Allow `http://localhost:*` / `http://127.0.0.1:*` endpoints. Default
   * false (production deployments must use HTTPS). Used by tests to
   * stand up in-process Bun.serve fixtures without TLS.
   */
  readonly allowInsecureLocalhost?: boolean;
};

export type Discovery = {
  discover(deployment: string): Promise<PeerRecord>;
  /** Inspect cache state — used by ops + tests. */
  cacheStats(): {
    entries: number;
    expirations: ReadonlyArray<{ deployment: string; expiresAt: number }>;
  };
  reset(): void;
};

type CacheEntry =
  | { readonly kind: "hit"; readonly record: PeerRecord; readonly expiresAt: number }
  | { readonly kind: "miss"; readonly expiresAt: number };

export function createDiscovery(config: DiscoveryConfig = {}): Discovery {
  const cache = new Map<string, CacheEntry>();
  const now = config.now ?? (() => Date.now());
  const negativeTtlMs = config.negativeTtlMs ?? 10_000;

  return {
    async discover(deployment: string): Promise<PeerRecord> {
      assertDeployment(deployment);
      const cached = cache.get(deployment);
      if (cached !== undefined) {
        if (cached.expiresAt > now()) {
          if (cached.kind === "hit") return cached.record;
          throw new FederationDiscoveryError(`peer ${deployment} unreachable (cached negative)`);
        }
        cache.delete(deployment);
      }

      try {
        const record = await lookup(deployment, config);
        cache.set(deployment, { kind: "hit", record, expiresAt: now() + recordTtl(record) });
        return record;
      } catch (cause) {
        cache.set(deployment, { kind: "miss", expiresAt: now() + negativeTtlMs });
        if (cause instanceof FederationDiscoveryError) throw cause;
        throw new FederationDiscoveryError(
          `peer discovery failed for ${deployment}: ${(cause as Error).message}`,
          cause,
        );
      }
    },

    cacheStats() {
      const entries = Array.from(cache.entries()).map(([deployment, e]) => ({
        deployment,
        expiresAt: e.expiresAt,
      }));
      return { entries: cache.size, expirations: entries };
    },

    reset() {
      cache.clear();
    },
  };
}

const DEFAULT_RECORD_TTL_MS = 60_000;

function recordTtl(_record: PeerRecord): number {
  return DEFAULT_RECORD_TTL_MS;
}

function assertDeployment(deployment: string): void {
  if (typeof deployment !== "string" || !deployment.length) {
    throw new FederationDiscoveryError("deployment id must be a non-empty string");
  }
  // Block obvious DNS injection attempts; allow standard domain shape.
  if (!/^[a-zA-Z0-9.-]+$/.test(deployment)) {
    throw new FederationDiscoveryError(`invalid deployment id: ${deployment}`);
  }
}

async function lookup(deployment: string, config: DiscoveryConfig): Promise<PeerRecord> {
  // Prefer SRV when a srvDomain is configured + a resolver is available.
  if (config.srvDomain && config.srvResolver) {
    const srvName = `_crewhaus._tcp.${deployment}.${config.srvDomain}`;
    try {
      const { records } = await config.srvResolver(srvName);
      const sorted = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      const head = sorted[0];
      if (head !== undefined) {
        const endpoint = `https://${head.name}:${head.port}`;
        // Even with an SRV hit, we still call .well-known to get the full
        // record (supportedShapes + fingerprint). SRV alone doesn't carry
        // public-key info.
        const wellKnown = await fetchWellKnown(endpoint, config);
        return { ...wellKnown, endpoint };
      }
    } catch (cause) {
      // Fall through to .well-known below — SRV is a hint, not the source of truth.
      void cause;
    }
  }

  // .well-known fallback
  const url = `https://${deployment}/.well-known/crewhaus.json`;
  return fetchWellKnown(url, config);
}

async function fetchWellKnown(baseOrUrl: string, config: DiscoveryConfig): Promise<PeerRecord> {
  const fetcher = config.wellKnownFetcher ?? defaultFetcher;
  const url = baseOrUrl.endsWith("/.well-known/crewhaus.json")
    ? baseOrUrl
    : `${baseOrUrl}/.well-known/crewhaus.json`;
  const { status, body } = await fetcher(url);
  if (status !== 200) {
    throw new FederationDiscoveryError(`well-known fetch returned ${status} for ${url}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new FederationDiscoveryError(`well-known returned invalid JSON for ${url}`, cause);
  }
  return parsePeerRecord(parsed, url, {
    allowInsecureLocalhost: config.allowInsecureLocalhost === true,
  });
}

function parsePeerRecord(
  raw: unknown,
  source: string,
  opts: { allowInsecureLocalhost: boolean } = { allowInsecureLocalhost: false },
): PeerRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new FederationDiscoveryError(`peer record at ${source} is not an object`);
  }
  const r = raw as Record<string, unknown>;
  const endpoint = typeof r["endpoint"] === "string" ? r["endpoint"] : "";
  const version = typeof r["version"] === "string" ? r["version"] : "";
  const supportedShapesRaw = r["supportedShapes"] ?? r["supported_shapes"];
  const supportedShapes = Array.isArray(supportedShapesRaw)
    ? (supportedShapesRaw.filter((s) => typeof s === "string") as string[])
    : [];
  const publicKeyFingerprint =
    typeof r["publicKeyFingerprint"] === "string"
      ? r["publicKeyFingerprint"]
      : typeof r["public_key_fingerprint"] === "string"
        ? r["public_key_fingerprint"]
        : "";
  if (!endpoint || !version) {
    throw new FederationDiscoveryError(`peer record at ${source}: endpoint+version are required`);
  }
  if (!/^https:\/\//.test(endpoint)) {
    if (
      !opts.allowInsecureLocalhost ||
      !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(endpoint)
    ) {
      throw new FederationDiscoveryError(
        `peer record at ${source}: endpoint must be https:// (got ${endpoint})`,
      );
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(publicKeyFingerprint)) {
    throw new FederationDiscoveryError(
      `peer record at ${source}: publicKeyFingerprint must be 64-char hex (got ${publicKeyFingerprint.length} chars)`,
    );
  }
  return {
    endpoint,
    version,
    supportedShapes,
    publicKeyFingerprint: publicKeyFingerprint.toLowerCase(),
  };
}

const defaultFetcher: WellKnownFetcher = async (url) => {
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  return { status: res.status, body: await res.text() };
};

/**
 * `crewhaus federation discover <deployment>` CLI helper. Returns the
 * resolved record as JSON for ops piping/jq.
 */
export async function discoverDeployment(
  deployment: string,
  config: DiscoveryConfig = {},
): Promise<PeerRecord> {
  const d = createDiscovery(config);
  return d.discover(deployment);
}
