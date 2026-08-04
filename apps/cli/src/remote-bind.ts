/**
 * HM-201 — the remote-bind opt-in for the Hangar console.
 *
 * `crewhaus hangar --host <h>` moves the console off loopback. What moves
 * with it is machine control: the console starts and stops processes, reads
 * every transcript, and writes `.env`-adjacent data — protected by a bearer
 * token over plain HTTP, with no TLS, no origin pinning and no rate
 * limiting. That posture is fine on 127.0.0.1 and poor on a LAN, so a
 * non-loopback bind additionally requires an explicit opt-in environment
 * variable ({@link REMOTE_BIND_ENV}). The fleet cannot then be exposed by
 * muscle memory — only by a deliberate act, visible in the shell that
 * performed it.
 *
 * The refusal names the variable AND the supported answer: put the console
 * behind a private network (Tailscale, an SSH tunnel) rather than
 * port-forwarding it. CrewHaus does not own transport security, and saying
 * so in the error is cheaper than a docs page nobody reads at 2am.
 *
 * Pure policy, no I/O. The environment is injected, never read from ambient
 * `process.env`, so the same function serves the CLI and its tests.
 */

/** The opt-in variable. Named in every refusal — an error that withholds
 *  the escape hatch just gets worked around with something worse. */
export const REMOTE_BIND_ENV = "CREWHAUS_HANGAR_ALLOW_REMOTE";

/** Truthy values for {@link REMOTE_BIND_ENV}, matching the registry's
 *  `CREWHAUS_NO_REGISTRY` convention (`1` / `true`). An empty or absent
 *  value, `0`, and anything else are all "not opted in": the check is an
 *  allow-list precisely because a typo must fail CLOSED. */
export function isRemoteBindOptedIn(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[REMOTE_BIND_ENV];
  return raw === "1" || raw === "true";
}

/**
 * True when binding `host` reaches only this machine.
 *
 * Loopback is `127.0.0.0/8`, `::1` (in any of its spellings, bracketed or
 * not), the IPv4-mapped form `::ffff:127.x.x.x`, and the name `localhost`.
 *
 * Everything else is remote — including the two values that LOOK innocent:
 * `0.0.0.0` and `::` are the wildcards, and they bind every interface the
 * machine has. A hostname is never resolved here: resolution is not ours to
 * trust (DNS answers change, and a name can be pointed anywhere), so an
 * unrecognised host fails closed and the operator opts in explicitly.
 */
export function isLoopbackHost(host: string): boolean {
  // IPv6 literals arrive bracketed from URLs and bare from a flag; accept
  // both, and compare case-insensitively (`::FFFF:127.0.0.1`, `LocalHost`).
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "") return false;
  if (h === "localhost") return true;

  // IPv6 loopback: `::1`, and the fully-written `0:0:0:0:0:0:0:1`. Compare
  // by expanding the groups rather than string-matching the shorthand.
  if (h.includes(":") && !h.startsWith("::ffff:")) {
    return isIpv6Loopback(h);
  }
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is an IPv4 address wearing a hat.
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return isIpv4Loopback(v4);
}

/** `127.0.0.0/8` — the WHOLE /8, not just `127.0.0.1`: a daemon bound to
 *  `127.0.0.2` is every bit as local. */
function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 127;
}

/** `::1` in any spelling. `::` (the wildcard) is deliberately NOT loopback. */
function isIpv6Loopback(host: string): boolean {
  if (host.includes("%")) return false; // scoped (`fe80::1%eth0`) — not loopback
  if (host.includes(":::")) return false; // malformed: never guess in this direction
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const groups: string[] =
    halves.length === 2
      ? expandGroups(halves[0] ?? "", halves[1] ?? "")
      : host.split(":").filter((g) => g !== "");
  if (groups.length !== 8) return false;
  return groups.every(
    (g, i) => /^[0-9a-f]{1,4}$/.test(g) && Number.parseInt(g, 16) === (i === 7 ? 1 : 0),
  );
}

/** Re-inflate a `::`-compressed address to its eight groups. */
function expandGroups(head: string, tail: string): string[] {
  const left = head.split(":").filter((g) => g !== "");
  const right = tail.split(":").filter((g) => g !== "");
  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return [];
  return [...left, ...Array<string>(zeros).fill("0"), ...right];
}

/**
 * The HM-201 gate. Returns the refusal message for a bind that needs the
 * opt-in and does not have it, or `undefined` when the bind may proceed.
 *
 * `host === undefined` is the default loopback bind — always allowed.
 *
 * Returning the message (rather than throwing) keeps this pure and lets the
 * caller decide the failure mode; `crewhaus hangar` throws it, which its
 * entry point routes through `die()` like every other flag refusal.
 */
export function remoteBindRefusal(
  host: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (host === undefined) return undefined;
  if (isLoopbackHost(host)) return undefined;
  if (isRemoteBindOptedIn(env)) return undefined;
  // Joined rather than concatenated: one line out, four readable lines in.
  return [
    `hangar serve: --host ${host} binds beyond loopback, and the console is machine control —`,
    "it starts processes, reads every transcript and writes credentials, over plain HTTP with",
    `no TLS. Set ${REMOTE_BIND_ENV}=1 to opt in, and put it behind a private network`,
    "(Tailscale, an SSH tunnel) — do not port-forward it.",
  ].join(" ");
}
