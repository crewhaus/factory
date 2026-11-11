/**
 * The owner's two blocks of the Hangar settings file (`<hangarRoot>/settings.json`):
 * `access` (a trusted reverse proxy, extra host names) and `links` (the address Home is
 * reached at). Only the owner writes them, by hand or with `crewhaus access proxy`; Home
 * reads them once at boot and never writes them, and its own settings writes carry them
 * through untouched.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";
import { isLoopbackAddress, parseCidr } from "./addresses";
import type { TrustedProxy } from "./authenticate";

/**
 * The Hangar settings file's name under the Hangar root.
 *
 * First consumers: Home's settings store, which shares it, and `crewhaus access proxy`.
 */
export const SETTINGS_FILENAME = "settings.json";

/**
 * The blocks of the settings file that are the owner's.
 *
 * First consumer: Home's settings store, which carries them through its writes.
 */
export const OWNER_BLOCKS = ["access", "links"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type OwnerSettings = {
  readonly trustedProxy?: TrustedProxy;
  readonly allowedHosts: readonly string[];
  /** `links.baseUrl`: https, or http on a loopback host. */
  readonly baseUrl?: string;
};

export type OwnerSettingsRead =
  | { readonly ok: true; readonly settings: OwnerSettings; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME_RE = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Headers a proxy must not name as its identity header. */
const RESERVED_HEADERS = new Set([
  "authorization",
  "host",
  "cookie",
  "forwarded",
  "x-real-ip",
  "crewhaus-proxy-secret",
]);

/** A host name or address a browser sends in `Host`, lower-cased; `undefined` when it is not one. */
function hostNameValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  if (HOST_NAME_RE.test(bare)) return bare;
  if (bare.includes(":") && parseCidr(bare) !== undefined && !bare.includes("/")) return bare;
  return undefined;
}

function isLoopbackHostName(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "localhost" || isLoopbackAddress(bare);
}

function fieldFault(path: string, field: string, problem: string): OwnerSettingsRead {
  return { ok: false, reason: `${path}: ${field} ${problem}` };
}

function hostList(path: string, field: string, value: unknown): string[] | OwnerSettingsRead {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fieldFault(path, field, "must be a list of host names");
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    const host = hostNameValue(entry);
    if (host === undefined) return fieldFault(path, `${field}[${i}]`, "is not a host name");
    out.push(host);
  }
  return out;
}

function onlyKeys(
  path: string,
  field: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): OwnerSettingsRead | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      return fieldFault(path, `${field}.${key}`, "is not a setting Home knows");
  }
  return undefined;
}

/**
 * Read and check the owner's `access` and `links` blocks. An `access` block that is not
 * right refuses boot with one line naming the file and the field; a `links.baseUrl` that
 * is not right is warned about and ignored. A file that is missing or not JSON holds no
 * owner settings (the settings store already says so).
 *
 * First consumer: Home's boot (`startHangarServer`).
 */
export function readOwnerSettings(hangarRoot: string): OwnerSettingsRead {
  const path = join(hangarRoot, SETTINGS_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: true, settings: { allowedHosts: [] }, warnings: [] };
  }
  if (!isRecord(raw)) return { ok: true, settings: { allowedHosts: [] }, warnings: [] };
  const warnings: string[] = [];
  let trustedProxy: TrustedProxy | undefined;
  let allowed: string[] = [];
  const access = raw["access"];
  if (access !== undefined) {
    if (!isRecord(access)) return fieldFault(path, "access", "must be an object");
    const extra = onlyKeys(path, "access", access, ["trustedProxy", "allowedHosts"]);
    if (extra !== undefined) return extra;
    const hosts = hostList(path, "access.allowedHosts", access["allowedHosts"]);
    if (!Array.isArray(hosts)) return hosts;
    allowed = hosts;
    const proxy = access["trustedProxy"];
    if (proxy !== undefined) {
      const field = "access.trustedProxy";
      if (!isRecord(proxy)) return fieldFault(path, field, "must be an object");
      const extraProxy = onlyKeys(path, field, proxy, [
        "header",
        "peers",
        "hosts",
        "secretDigest",
        "socket",
      ]);
      if (extraProxy !== undefined) return extraProxy;
      const header = proxy["header"];
      if (typeof header !== "string" || !HEADER_NAME_RE.test(header)) {
        return fieldFault(path, `${field}.header`, "must be a header name (letters, digits and -)");
      }
      const lower = header.toLowerCase();
      if (RESERVED_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) {
        return fieldFault(path, `${field}.header`, "names a header Home reserves");
      }
      const peers = proxy["peers"];
      if (!Array.isArray(peers))
        return fieldFault(path, `${field}.peers`, "must be a list of CIDR blocks");
      for (const [i, peer] of peers.entries()) {
        if (typeof peer !== "string" || parseCidr(peer) === undefined) {
          return fieldFault(path, `${field}.peers[${i}]`, "is not a CIDR block");
        }
      }
      const proxyHosts = hostList(path, `${field}.hosts`, proxy["hosts"]);
      if (!Array.isArray(proxyHosts)) return proxyHosts;
      const digest = proxy["secretDigest"];
      if (digest !== undefined && (typeof digest !== "string" || !HEX64_RE.test(digest))) {
        return fieldFault(path, `${field}.secretDigest`, "must be 64 lowercase hex characters");
      }
      const socket = proxy["socket"];
      if (socket !== undefined && socket !== true) {
        return fieldFault(path, `${field}.socket`, "must be true or left out");
      }
      if (digest === undefined && socket !== true) {
        return fieldFault(
          path,
          field,
          "needs a proof that a request came from the proxy: secretDigest or socket (`crewhaus access proxy` sets one)",
        );
      }
      trustedProxy = {
        header: lower,
        peers: peers as string[],
        hosts: proxyHosts,
        ...(digest !== undefined ? { secretDigest: digest as string } : {}),
        ...(socket === true ? { socket: true as const } : {}),
      };
    }
  }
  let baseUrl: string | undefined;
  const links = raw["links"];
  if (links !== undefined) {
    if (!isRecord(links)) {
      warnings.push(`${path}: links must be an object; it is ignored`);
    } else if (links["baseUrl"] !== undefined) {
      const candidate = links["baseUrl"];
      let parsed: URL | undefined;
      try {
        parsed = typeof candidate === "string" ? new URL(candidate) : undefined;
      } catch {
        parsed = undefined;
      }
      const ok =
        parsed !== undefined &&
        parsed.username === "" &&
        parsed.password === "" &&
        (parsed.protocol === "https:" ||
          (parsed.protocol === "http:" && isLoopbackHostName(parsed.hostname)));
      if (ok && parsed !== undefined) baseUrl = parsed.origin;
      else {
        warnings.push(
          `${path}: links.baseUrl must be an https address, or http on this computer; it is ignored`,
        );
      }
    }
  }
  return {
    ok: true,
    settings: {
      ...(trustedProxy !== undefined ? { trustedProxy } : {}),
      allowedHosts: allowed,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    },
    warnings,
  };
}

/**
 * Set (or, with `undefined`, remove) one owner block, keeping every other key of the
 * file as it is. Written through a randomly named temp file in the Hangar root, then moved
 * into place; a link at the file's name is refused, never followed.
 *
 * First consumer: `crewhaus access proxy`.
 */
export function writeOwnerBlock(
  hangarRoot: string,
  key: (typeof OWNER_BLOCKS)[number],
  value: Readonly<Record<string, unknown>> | undefined,
): void {
  const path = join(hangarRoot, SETTINGS_FILENAME);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) throw new Error(`${path} is not a JSON object; fix it by hand first`);
    current = raw;
  }
  const { [key]: _old, ...rest } = current;
  const next: Record<string, unknown> = value === undefined ? rest : { ...current, [key]: value };
  mkdirSync(hangarRoot, { recursive: true, mode: 0o700 });
  const written = writeFileSafe(
    hangarRoot,
    SETTINGS_FILENAME,
    `${JSON.stringify(next, null, 2)}\n`,
    {
      overwrite: true,
      mode: 0o600,
    },
  );
  if (!written.ok) throw new Error(`${path} could not be written: ${written.reason}`);
}
