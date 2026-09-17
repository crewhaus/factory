/**
 * Choosing the address `crewhaus hangar --lan` should advertise.
 *
 * A phone cannot reach `127.0.0.1`, so the QR code has to carry a concrete
 * address on a network the phone is also on. `os.networkInterfaces()` gives
 * a pile of candidates and no ranking, and on a developer's laptop most of
 * them are wrong: VPN tunnels (`utun*`, `tun*`), Apple Wireless Direct Link
 * (`awdl*`, `llw*`), container and VM bridges (`docker*`, `vmnet*`,
 * `vboxnet*`, `bridge*`) and link-local autoconfiguration (`169.254/16`) all
 * present as perfectly valid non-loopback interfaces. Printing a QR nobody
 * can scan is worse than printing none, so the choice is ranked rather than
 * first-come.
 *
 * IPv4 only. An IPv6 link-local address needs a zone index (`fe80::1%en0`)
 * that no browser will accept in a URL, and a global IPv6 address is not
 * what "the same network" means to someone holding a phone.
 *
 * Pure: the interface list is passed in, never read from the ambient
 * process, so the CLI and its tests share one implementation.
 */

/** The shape this module needs from `os.networkInterfaces()`. Declared
 *  structurally rather than importing Node's type, so a test can build one
 *  by hand without constructing a `NetworkInterfaceInfo`. */
export type InterfaceAddress = {
  readonly address: string;
  /** Node reports `"IPv4"`/`"IPv6"`; older shapes used 4/6. Both accepted. */
  readonly family: string | number;
  readonly internal: boolean;
};

export type InterfaceMap = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;

/** An address that survived the filter, with the interface that offered it. */
export type LanAddress = {
  readonly interfaceName: string;
  readonly address: string;
};

/**
 * Interface-name prefixes that are never the LAN a phone is on.
 *
 * `utun`/`tun`/`tap`/`ppp`/`wg` are tunnels; `awdl`/`llw` are Apple's
 * peer-to-peer radios; the rest are container, VM and virtual-switch
 * bridges. Matched case-insensitively on the name's leading letters, so
 * `utun3` and `vmnet8` are covered without enumerating every index.
 */
const VIRTUAL_PREFIXES: readonly string[] = [
  "awdl",
  "bridge",
  "docker",
  "llw",
  "ppp",
  "tailscale",
  "tap",
  "tun",
  "utun",
  "veth",
  "virbr",
  "vmnet",
  "vboxnet",
  "wg",
  "zt",
];

/** Interface-name prefixes that are usually the real thing, best first —
 *  wired and wireless ethernet on macOS, Linux and BSD. */
const PHYSICAL_PREFIXES: readonly string[] = ["en", "eth", "wlan", "wlp", "enp", "wl"];

function isIpv4(entry: InterfaceAddress): boolean {
  return entry.family === "IPv4" || entry.family === 4;
}

/** RFC 1918 — the ranges a home or office LAN actually uses. */
function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = octets;
  if (octets.length !== 4 || a === undefined || b === undefined) return false;
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/** 169.254/16 — an address a machine gave itself because DHCP failed. */
function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith("169.254.");
}

/** 100.64/10 — carrier-grade NAT, which is also where Tailscale lives.
 *  Routable and often the right answer, but it is not "the same network",
 *  so it ranks below a real LAN address. */
function isCarrierGradeNat(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = octets;
  if (a !== 100 || b === undefined) return false;
  return b >= 64 && b <= 127;
}

function isVirtualName(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function physicalRank(name: string): number {
  const lower = name.toLowerCase();
  const index = PHYSICAL_PREFIXES.findIndex((prefix) => lower.startsWith(prefix));
  return index === -1 ? PHYSICAL_PREFIXES.length : index;
}

/**
 * Every address that could plausibly serve a phone on the same network, best
 * first. Empty when the machine has none.
 *
 * The ranking, in order of decreasing confidence:
 *   1. a private (RFC 1918) address on a physical-looking interface,
 *   2. a private address on any other non-virtual interface,
 *   3. any other routable address on a non-virtual interface,
 *   4. a carrier-grade-NAT address (Tailscale and friends),
 *   5. anything left on a virtual interface.
 *
 * Ties break on the interface name so the answer is stable across boots —
 * `en0` before `en1`, never whichever the kernel happened to list first.
 */
export function lanAddresses(interfaces: InterfaceMap): LanAddress[] {
  const candidates: Array<LanAddress & { readonly rank: number }> = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!isIpv4(entry) || entry.internal) continue;
      if (isLinkLocalIpv4(entry.address)) continue;
      const virtual = isVirtualName(interfaceName);
      const priv = isPrivateIpv4(entry.address);
      const cgnat = isCarrierGradeNat(entry.address);
      let rank: number;
      if (virtual) rank = 4;
      else if (cgnat) rank = 3;
      else if (priv) rank = physicalRank(interfaceName) < PHYSICAL_PREFIXES.length ? 0 : 1;
      else rank = 2;
      candidates.push({ interfaceName, address: entry.address, rank });
    }
  }
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      physicalRank(a.interfaceName) - physicalRank(b.interfaceName) ||
      a.interfaceName.localeCompare(b.interfaceName) ||
      a.address.localeCompare(b.address),
  );
  return candidates.map(({ interfaceName, address }) => ({ interfaceName, address }));
}

/** The single best address, or undefined when the machine is offline (or
 *  has nothing but loopback, tunnels and link-local autoconfiguration). */
export function pickLanAddress(interfaces: InterfaceMap): LanAddress | undefined {
  return lanAddresses(interfaces)[0];
}

/** The refusal `--lan` prints when there is nothing to bind. Names the cause
 *  and the two things that actually fix it, because "no LAN address" reads
 *  like a bug and is nearly always Wi-Fi being off or a VPN owning every
 *  route. */
export const NO_LAN_ADDRESS_REFUSAL =
  "hangar serve: --lan found no LAN address on this machine — every interface is loopback, a VPN or container tunnel, or self-assigned (169.254.x.x). Join a network, or pass --host <address> to choose one yourself.";
