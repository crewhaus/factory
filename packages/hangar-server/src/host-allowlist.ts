/**
 * The Host allowlist: Home answers only the names it knows, before it authenticates
 * anything.
 *
 * A page on another site that rebinds its own DNS name to 127.0.0.1 reaches Home from
 * the owner's own browser, same-origin, but it still sends its own name in `Host`, which
 * a browser does not let a page change. Answering only known names turns that page away
 * with 421 Misdirected Request, on every path but `/healthz`, on every listener, before
 * a boot link is spent or a file is served.
 *
 * The names: `localhost`, `127.0.0.1` and `[::1]`; each address a listener bound (for a
 * wildcard bind, the addresses this computer's interfaces report at boot, never the
 * wildcard itself); the trusted proxy's public names; the owner's `access.allowedHosts`;
 * the host of `links.baseUrl`; and `--allow-host` additions. A name is compared
 * lower-case, without its port, an IPv6 address in brackets, and with no trailing-dot
 * leniency. A request with no `Host` is refused.
 */
import { networkInterfaces } from "node:os";

/** The plain-text answer to a name Home does not know. The same on every path. */
export const MISDIRECTED_TEXT = "This address is not one Home answers to.";

export type InterfaceAddresses = () => Readonly<
  Record<
    string,
    ReadonlyArray<{ readonly address: string; readonly family: string | number }> | undefined
  >
>;

export type AllowlistInput = {
  /** The hostname each listener bound (`127.0.0.1`, a LAN address, `0.0.0.0`, `::`). */
  readonly bound: readonly string[];
  readonly trustedProxyHosts?: readonly string[];
  readonly allowedHosts?: readonly string[];
  /** The host of `links.baseUrl`, when the owner set one. */
  readonly baseUrlHost?: string;
  /** `--allow-host` additions. */
  readonly allowHosts?: readonly string[];
  /** This computer's addresses, read for a wildcard bind. */
  readonly interfaces?: InterfaceAddresses;
};

const WILDCARDS = new Set(["0.0.0.0", "::", "[::]"]);

/** A name as the allowlist keeps it: lower-case, an IPv6 address in brackets. */
export function normalizeHostName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) return lower;
  return lower.includes(":") ? `[${lower}]` : lower;
}

/**
 * The set of names Home answers.
 *
 * First consumer: `startHangarServer`, once at boot.
 */
export function allowedHosts(input: AllowlistInput): ReadonlySet<string> {
  const out = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
  for (const host of input.bound) {
    if (WILDCARDS.has(host.toLowerCase())) {
      const map = (input.interfaces ?? (networkInterfaces as unknown as InterfaceAddresses))();
      for (const list of Object.values(map)) {
        for (const entry of list ?? []) {
          // Drop a zone (`fe80::1%en0`): a browser never sends one in Host.
          const address = entry.address.split("%")[0] as string;
          if (address !== "") out.add(normalizeHostName(address));
        }
      }
      continue;
    }
    out.add(normalizeHostName(host));
  }
  for (const list of [input.trustedProxyHosts, input.allowedHosts, input.allowHosts]) {
    for (const host of list ?? []) out.add(normalizeHostName(host));
  }
  if (input.baseUrlHost !== undefined && input.baseUrlHost !== "") {
    out.add(normalizeHostName(input.baseUrlHost));
  }
  return out;
}

/** The name in a `Host` header, without its port, or `undefined` when it is not one. */
export function hostNameOf(header: string | null | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const value = header.trim().toLowerCase();
  if (value === "") return undefined;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return undefined;
    const rest = value.slice(close + 1);
    if (rest !== "" && !/^:[0-9]{1,5}$/.test(rest)) return undefined;
    return value.slice(0, close + 1);
  }
  const colon = value.indexOf(":");
  if (colon === -1) return value;
  if (value.indexOf(":", colon + 1) !== -1) return undefined;
  const port = value.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(port)) return undefined;
  const name = value.slice(0, colon);
  return name === "" ? undefined : name;
}

/**
 * Whether Home answers this `Host`. A missing or malformed header is not.
 *
 * First consumer: `handle` in `server.ts`, before everything but `/healthz`.
 */
export function hostAllowed(
  header: string | null | undefined,
  hosts: ReadonlySet<string>,
): boolean {
  const name = hostNameOf(header);
  return name !== undefined && hosts.has(name);
}

/**
 * The 421 answer: plain text, never cached, the same on every path, so it says nothing
 * about what lies behind it.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function misdirected(): Response {
  return new Response(`${MISDIRECTED_TEXT}\n`, {
    status: 421,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
