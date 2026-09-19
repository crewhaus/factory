/**
 * Parsers for the machine's network configuration: interfaces from three
 * different tools, resolvers from two, and the proxy environment.
 *
 * The three interface sources do not agree on anything. `ip -j addr` gives
 * typed JSON with a prefix length; `ifconfig` gives a HEX netmask and puts
 * the carrier state on its own `status:` line; `os.networkInterfaces()` has
 * no MTU and no flags at all and silently omits an interface that is down.
 * They are normalised to one shape here, and the shape keeps `adminUp` (the
 * administrative flag) apart from `link` (whether a cable or radio is
 * actually connected) because an interface that is UP with no carrier is the
 * common "why can't I reach anything" case and collapsing the two hides it.
 */

export type HostAddress = {
  readonly family: "ipv4" | "ipv6";
  readonly address: string;
  /** Null when the source did not say — never defaulted to /32 or /64. */
  readonly prefixLength: number | null;
  /** "global" | "host" | "link", where the source distinguishes them. */
  readonly scope: string | null;
  /** IPv6 zone from `fe80::1%lo0`, kept out of `address` so two sources can
   *  be compared. */
  readonly zone?: string;
};

export type HostInterface = {
  readonly name: string;
  /** The UP flag: the administrator's intent. */
  readonly adminUp: boolean | null;
  /** Carrier: "active" when something is actually connected. */
  readonly link: "active" | "inactive" | null;
  readonly loopback: boolean | null;
  readonly mtu: number | null;
  readonly mac: string | null;
  readonly addresses: ReadonlyArray<HostAddress>;
};

/**
 * `0xffffff00` -> 24.
 *
 * BSD `ifconfig` prints the netmask in hex and nothing else; there is no
 * prefix length anywhere in its output. A mask whose bits are not contiguous
 * (0xffff00ff) is not a prefix at all, and answering with a bit count would
 * be inventing one, so it comes back null.
 */
export function hexNetmaskToPrefix(hex: string): number | null {
  const match = hex.trim().match(/^0x([0-9a-fA-F]{1,8})$/);
  if (match === null) return null;
  const value = Number.parseInt(match[1] as string, 16) >>> 0;
  return maskToPrefix(value);
}

/** `255.255.255.0` -> 24, for the dotted form `os.networkInterfaces()` uses. */
export function dottedNetmaskToPrefix(mask: string): number | null {
  const parts = mask.trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return maskToPrefix(value);
}

function maskToPrefix(value: number): number | null {
  // Contiguity check: a valid mask is a run of ones followed by a run of
  // zeroes, so inverting and adding one must yield a power of two.
  const inverted = (~value >>> 0) + 1;
  if ((inverted & (inverted - 1)) !== 0 && value !== 0xffffffff) return null;
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((value & (1 << i)) === 0) break;
    bits++;
  }
  return bits;
}

/** Split `fe80::1%lo0` into the address and its zone. */
function splitZone(address: string): { address: string; zone?: string } {
  const at = address.indexOf("%");
  if (at < 0) return { address };
  return { address: address.slice(0, at), zone: address.slice(at + 1) };
}

/**
 * Parse BSD/macOS `ifconfig -a`.
 *
 * Interface headers are anchored at column 0. They cannot be found by
 * "line contains a colon": `bridge0` prints `Configuration:` and `member:
 * en2 flags=3<LEARNING,DISCOVER>` as INDENTED lines, and a looser anchor
 * turns each of them into a phantom interface named "member".
 */
export function parseIfconfig(text: string): HostInterface[] {
  const out: HostInterface[] = [];
  let current: {
    name: string;
    flags: string[];
    mtu: number | null;
    mac: string | null;
    status: string | null;
    addresses: HostAddress[];
  } | null = null;

  const flush = (): void => {
    if (current === null) return;
    out.push({
      name: current.name,
      adminUp: current.flags.includes("UP"),
      link:
        current.status === null
          ? null
          : current.status === "active"
            ? "active"
            : ("inactive" as const),
      loopback: current.flags.includes("LOOPBACK"),
      mtu: current.mtu,
      mac: current.mac,
      addresses: current.addresses,
    });
    current = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const header = line.match(/^(\S+):\s*flags=\d+<([^>]*)>(?:\s+mtu\s+(\d+))?/);
    if (header !== null) {
      flush();
      const mtuText = header[3];
      current = {
        name: header[1] as string,
        flags: (header[2] as string).split(",").filter((f) => f !== ""),
        mtu: mtuText === undefined ? null : Number(mtuText),
        mac: null,
        status: null,
        addresses: [],
      };
      continue;
    }
    if (current === null) continue;
    const body = line.trim();

    const ether = body.match(/^ether\s+([0-9a-fA-F:]{11,17})/);
    if (ether !== null) {
      current.mac = (ether[1] as string).toLowerCase();
      continue;
    }
    const status = body.match(/^status:\s*(\S+)/);
    if (status !== null) {
      current.status = (status[1] as string).toLowerCase();
      continue;
    }
    const inet = body.match(/^inet\s+(\S+)(?:\s+netmask\s+(\S+))?/);
    if (inet !== null) {
      const mask = inet[2];
      current.addresses.push({
        family: "ipv4",
        address: inet[1] as string,
        prefixLength:
          mask === undefined
            ? null
            : mask.startsWith("0x")
              ? hexNetmaskToPrefix(mask)
              : dottedNetmaskToPrefix(mask),
        scope: null,
      });
      continue;
    }
    const inet6 = body.match(/^inet6\s+(\S+)(?:\s+prefixlen\s+(\d+))?/);
    if (inet6 !== null) {
      const { address, zone } = splitZone(inet6[1] as string);
      const prefix = inet6[2];
      current.addresses.push({
        family: "ipv6",
        address,
        prefixLength: prefix === undefined ? null : Number(prefix),
        // BSD prints no scope keyword; fe80:: is link-local by definition.
        scope: address.toLowerCase().startsWith("fe80") ? "link" : null,
        ...(zone === undefined ? {} : { zone }),
      });
    }
  }
  flush();
  return out;
}

/**
 * Parse iproute2's `ip -j addr` (JSON).
 *
 * JSON is preferred wherever a tool emits it — no column alignment, no
 * locale, and the prefix length arrives as a number instead of as a hex mask
 * to decode. It is not available everywhere, though: busybox `ip` has no
 * `-j` at all and answers the flag with its usage text and exit 1 (captured
 * in the fixtures), and some iproute2 builds emit JSON the parser here
 * refuses. Both land on the text parser below, which is why it still exists.
 *
 * Returns null — not an empty list — when the text is not the JSON array
 * this expects, so the caller can fall back instead of reporting a machine
 * with no interfaces.
 */
export function parseIpJson(text: string): HostInterface[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: HostInterface[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row["ifname"] === "string" ? row["ifname"] : null;
    if (name === null) continue;
    const flags = Array.isArray(row["flags"])
      ? (row["flags"] as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const addresses: HostAddress[] = [];
    const info = Array.isArray(row["addr_info"]) ? (row["addr_info"] as unknown[]) : [];
    for (const item of info) {
      if (typeof item !== "object" || item === null) continue;
      const addr = item as Record<string, unknown>;
      const local = addr["local"];
      const family = addr["family"];
      if (typeof local !== "string" || (family !== "inet" && family !== "inet6")) continue;
      const prefix = addr["prefixlen"];
      addresses.push({
        family: family === "inet" ? "ipv4" : "ipv6",
        address: local,
        prefixLength: typeof prefix === "number" ? prefix : null,
        scope: typeof addr["scope"] === "string" ? (addr["scope"] as string) : null,
      });
    }
    const mtu = row["mtu"];
    const mac = row["address"];
    out.push({
      name,
      adminUp: flags.includes("UP"),
      link: flags.includes("LOWER_UP") ? "active" : "inactive",
      loopback: flags.includes("LOOPBACK") || row["link_type"] === "loopback",
      mtu: typeof mtu === "number" ? mtu : null,
      mac: typeof mac === "string" ? mac.toLowerCase() : null,
      addresses,
    });
  }
  return out;
}

/**
 * Parse `ip addr` text, the form busybox and every older iproute2 print.
 *
 * Header lines are `38: eth0@if39: <FLAGS> mtu 1500 ...` — the interface
 * name stops at the `@`, which names the peer of a veth or tunnel and is not
 * part of the name. `state UP` is not used for the carrier because loopback
 * reports `state UNKNOWN`; the LOWER_UP flag is the carrier bit.
 */
export function parseIpAddrText(text: string): HostInterface[] {
  const out: HostInterface[] = [];
  let current: (HostInterface & { addresses: HostAddress[] }) | null = null;
  let flags: string[] = [];

  const flush = (): void => {
    if (current !== null) out.push(current);
    current = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const header = line.match(/^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>(?:\s+mtu\s+(\d+))?/);
    if (header !== null) {
      flush();
      flags = (header[2] as string).split(",").filter((f) => f !== "");
      const mtuText = header[3];
      current = {
        name: header[1] as string,
        adminUp: flags.includes("UP"),
        link: flags.includes("LOWER_UP") ? "active" : "inactive",
        loopback: flags.includes("LOOPBACK"),
        mtu: mtuText === undefined ? null : Number(mtuText),
        mac: null,
        addresses: [],
      };
      continue;
    }
    if (current === null) continue;
    const body = line.trim();

    const link = body.match(/^link\/(\S+)\s+(\S+)/);
    if (link !== null) {
      const kind = link[1] as string;
      if (kind === "loopback") current = { ...current, loopback: true };
      const mac = link[2] as string;
      // Exactly six octets. A tunnel's `link/ipip 0.0.0.0` is an address
      // rather than a MAC, and an ip6tnl's link address is SIXTEEN octets in
      // the same position — a looser pattern reports that as this machine's
      // hardware address.
      if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac))
        current = { ...current, mac: mac.toLowerCase() };
      continue;
    }
    const inet = body.match(/^(inet6?)\s+([^/\s]+)(?:\/(\d+))?/);
    if (inet !== null) {
      const scope = body.match(/\bscope\s+(\S+)/)?.[1] ?? null;
      const { address, zone } = splitZone(inet[2] as string);
      const prefix = inet[3];
      current.addresses.push({
        family: inet[1] === "inet" ? "ipv4" : "ipv6",
        address,
        prefixLength: prefix === undefined ? null : Number(prefix),
        scope,
        ...(zone === undefined ? {} : { zone }),
      });
    }
  }
  flush();
  return out;
}

/**
 * Interfaces as `os.networkInterfaces()` sees them: the last resort, used
 * when no command answered.
 *
 * It is a weaker source and the result says so. There is no MTU and no flag
 * set, so `mtu`, `adminUp` and `link` are null rather than guessed — and an
 * interface that is down, or up with no address, does not appear in this map
 * AT ALL, so the list is not a complete inventory of the machine's hardware.
 */
export function interfacesFromOsMap(
  map: Readonly<
    Record<
      string,
      | ReadonlyArray<{
          address: string;
          family: string | number;
          internal: boolean;
          mac?: string;
          netmask?: string;
          cidr?: string | null;
        }>
      | undefined
    >
  >,
): HostInterface[] {
  const out: HostInterface[] = [];
  // Sorted: object key order is insertion order, which is the order the OS
  // happened to hand them over, and a tool whose output depends on that is
  // not deterministic.
  for (const name of Object.keys(map).sort()) {
    const entries = map[name];
    if (entries === undefined) continue;
    const addresses: HostAddress[] = [];
    let mac: string | null = null;
    let loopback: boolean | null = null;
    for (const entry of entries) {
      const isV6 = entry.family === "IPv6" || entry.family === 6;
      const fromCidr = entry.cidr?.match(/\/(\d+)$/)?.[1];
      const prefix =
        fromCidr !== undefined
          ? Number(fromCidr)
          : entry.netmask === undefined
            ? null
            : isV6
              ? null
              : dottedNetmaskToPrefix(entry.netmask);
      const { address, zone } = splitZone(entry.address);
      addresses.push({
        family: isV6 ? "ipv6" : "ipv4",
        address,
        prefixLength: prefix,
        scope: null,
        ...(zone === undefined ? {} : { zone }),
      });
      if (mac === null && entry.mac !== undefined && entry.mac !== "") mac = entry.mac;
      loopback = loopback === true ? true : entry.internal;
    }
    out.push({ name, adminUp: null, link: null, loopback, mtu: null, mac, addresses });
  }
  return out;
}

export type ResolvConf = {
  readonly resolvers: ReadonlyArray<string>;
  readonly searchDomains: ReadonlyArray<string>;
};

/**
 * Parse /etc/resolv.conf.
 *
 * Used as a cross-check on `dns.getServers()`, which answers with an empty
 * list both when no resolver is configured and when the runtime could not
 * read the configuration. Those are different facts and a caller acts
 * differently on them, so when the list is empty this file decides which one
 * it was.
 *
 * Per resolv.conf(5) the LAST `search` wins, and `search` and `domain` are
 * mutually exclusive with the last one read taking effect.
 */
export function parseResolvConf(text: string): ResolvConf {
  const resolvers: string[] = [];
  let searchDomains: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0];
    if (keyword === "nameserver" && parts[1] !== undefined) resolvers.push(parts[1]);
    else if (keyword === "search") searchDomains = parts.slice(1);
    else if (keyword === "domain" && parts[1] !== undefined) searchDomains = [parts[1]];
  }
  return { resolvers, searchDomains };
}

export type ProxyEntry = {
  /** The proxy URL with any credentials removed. */
  readonly url: string;
  /** Which variable it came from, exactly as spelled. */
  readonly from: string;
  readonly credentials: "none" | "redacted";
};

export type ProxyView = {
  readonly http: ProxyEntry | null;
  readonly https: ProxyEntry | null;
  readonly all: ProxyEntry | null;
  readonly noProxy: ReadonlyArray<string> | null;
  /** Cases where two spellings disagree, each with the rule that decides. */
  readonly conflicts: ReadonlyArray<string>;
};

/**
 * Strip credentials out of a proxy URL.
 *
 * `http_proxy` routinely carries `user:password@` and this result is read by
 * a model and written into a transcript, so the password must not survive
 * the trip. A value that does not parse as a URL is still cut at its last
 * `@`, because failing to parse is not a reason to print a secret.
 */
export function redactProxyUrl(value: string): { url: string; credentials: "none" | "redacted" } {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (url.username === "" && url.password === "") {
      return { url: trimmed, credentials: "none" };
    }
    url.username = "";
    url.password = "";
    return { url: url.toString().replace(/\/$/, ""), credentials: "redacted" };
  } catch {
    const at = trimmed.lastIndexOf("@");
    if (at < 0) return { url: trimmed, credentials: "none" };
    const scheme = trimmed.match(/^[a-zA-Z][\w+.-]*:\/\//)?.[0] ?? "";
    return { url: `${scheme}${trimmed.slice(at + 1)}`, credentials: "redacted" };
  }
}

/**
 * Read the proxy environment.
 *
 * Both spellings are looked up, and a disagreement is REPORTED rather than
 * resolved silently, because the clients on a machine do not agree either:
 * curl and most libraries prefer the lowercase name, and curl ignores
 * uppercase `HTTP_PROXY` for http entirely — a CGI process inherits the
 * request's `Proxy:` header as `HTTP_PROXY`, which is the httpoxy
 * vulnerability (CVE-2016-5387). Picking one and saying nothing would make
 * this tool disagree with whatever the caller's HTTP client then does.
 */
export function proxyFromEnv(env: Readonly<Record<string, string | undefined>>): ProxyView {
  const conflicts: string[] = [];
  const pick = (lower: string, upper: string, note: string): ProxyEntry | null => {
    const low = env[lower];
    const up = env[upper];
    if (low !== undefined && up !== undefined && low !== up) conflicts.push(note);
    const chosen =
      low !== undefined && low !== "" ? lower : up !== undefined && up !== "" ? upper : null;
    if (chosen === null) return null;
    const value = env[chosen] as string;
    const { url, credentials } = redactProxyUrl(value);
    return { url, from: chosen, credentials };
  };

  const http = pick(
    "http_proxy",
    "HTTP_PROXY",
    "http_proxy and HTTP_PROXY differ; curl and most clients use http_proxy and ignore HTTP_PROXY for http (httpoxy, CVE-2016-5387), so http_proxy is reported",
  );
  const https = pick(
    "https_proxy",
    "HTTPS_PROXY",
    "https_proxy and HTTPS_PROXY differ; the lowercase name wins in curl and is reported",
  );
  const all = pick(
    "all_proxy",
    "ALL_PROXY",
    "all_proxy and ALL_PROXY differ; the lowercase name wins in curl and is reported",
  );
  const noProxyRaw = env["no_proxy"] ?? env["NO_PROXY"];
  const noProxy =
    noProxyRaw === undefined
      ? null
      : noProxyRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
  return { http, https, all, noProxy, conflicts };
}
