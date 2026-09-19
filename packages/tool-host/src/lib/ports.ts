/**
 * Parsers for listening TCP sockets, and the join that puts an owner on one.
 *
 * The reason there are five of these rather than one: no single command
 * answers the whole question on any platform.
 *
 *   - macOS. `lsof` is the only probe with process names, and unprivileged
 *     lsof can only open the file descriptors of its OWN uid, so a listener
 *     owned by another user is not listed at all. Captured side by side
 *     while writing this package: `netstat -an -p tcp` showed 20 listening
 *     sockets (ports 22, 88, 631, 5900, …) and `lsof` as an ordinary user
 *     showed 8. A tool built on lsof alone reports port 631 as free.
 *     So sockets come from netstat — every user, no owner — and lsof is
 *     joined on top for whatever owners it can see.
 *   - Linux. `ss` lists every socket but prints the `users:(…)` field only
 *     for processes it may inspect; GNU netstat prints `-` in the same
 *     situation. The socket is there either way; the owner is not.
 *   - Linux without iproute2. /proc/net/tcp and tcp6 are always readable and
 *     carry the owning UID but no pid or name.
 *   - Windows. `netstat -ano` carries the pid for every socket, and
 *     `tasklist` turns the pid into an image name.
 *
 * Which is why the output of `PortInspect` says, per socket, whether the
 * owner is known — and why "no listener on that port" is only ever claimed
 * from a source that sees every user's sockets.
 */

export type SocketOwner = {
  readonly pid: number | null;
  readonly process: string | null;
  readonly user: string | null;
  readonly uid: number | null;
};

export type ListenSocket = {
  /** "*" for a wildcard bind, otherwise the literal address. */
  readonly address: string;
  readonly port: number;
  readonly family: "ipv4" | "ipv6" | "dual";
  readonly owners: ReadonlyArray<SocketOwner>;
  /** False when the socket is real but its owning process could not be
   *  read. Never means "no process". */
  readonly ownerKnown: boolean;
};

const WILDCARDS = new Set(["*", "0.0.0.0", "::", "[::]", "0", ""]);

/** Wildcard binds are spelled four ways across these tools; one spelling
 *  makes the join between two sources possible. */
export function normalizeAddress(address: string): string {
  const bare = address.replace(/^\[|\]$/g, "");
  const withoutZone = bare.split("%")[0] as string;
  return WILDCARDS.has(withoutZone) ? "*" : withoutZone.toLowerCase();
}

/**
 * A port number, or null — from DIGITS, not from whatever `Number()` will
 * coerce. `Number("")` is 0 and `Number("0x16")` is 22, so a field that was
 * cut short (`127.0.0.1:`) or written in a form no port ever uses would
 * otherwise come back as a real port number on a real address, which a
 * caller then reads as something listening there.
 */
function portOf(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port <= 65535 ? port : null;
}

/** Split `0.0.0.0:22`, `[::]:22`, `:::9090`, `127.0.0.53%lo:53` — always at
 *  the LAST colon, because an IPv6 address is made of the others. */
export function splitColonPort(text: string): { address: string; port: number } | null {
  const at = text.lastIndexOf(":");
  if (at < 0) return null;
  const port = portOf(text.slice(at + 1));
  if (port === null) return null;
  return { address: normalizeAddress(text.slice(0, at)), port };
}

/** Split BSD's `*.8770`, `127.0.0.1.631`, `::1.631` — at the last DOT, which
 *  is the separator macOS uses instead of a colon, IPv6 included. */
export function splitDotPort(text: string): { address: string; port: number } | null {
  const at = text.lastIndexOf(".");
  if (at < 0) return null;
  const port = portOf(text.slice(at + 1));
  if (port === null) return null;
  return { address: normalizeAddress(text.slice(0, at)), port };
}

/**
 * Did this output come from the tool we asked for?
 *
 * The question is not rhetorical, and it decides whether "nothing is
 * listening" may be said at all. Zero parsed sockets has two causes that
 * look identical in the result: a machine with no listeners (a real answer)
 * and output the parser did not understand (no answer at all) — a wrapper
 * script that printed a warning and exited 0, a build whose columns are
 * different, a stub on a locked-down image. Each of these commands prints a
 * HEADER before its first row, on a host with no sockets as much as on a
 * busy one, so the header is the evidence that the tool itself answered.
 *
 * Applied only when nothing parsed: a source that produced rows has already
 * proved itself, and no header check should be able to throw those away.
 */
export function looksLikeSsOutput(text: string): boolean {
  return /^\s*(Netid\s+)?State\s+Recv-Q/im.test(text);
}

/** GNU/busybox `netstat -ltnp` and BSD `netstat -an -p tcp` both print an
 *  "Active Internet connections" banner and a `Proto Recv-Q` column head. */
export function looksLikeNetstatOutput(text: string): boolean {
  return /Active Internet connections/i.test(text) || /^\s*Proto\s+Recv-Q/im.test(text);
}

/** Windows `netstat -ano`. The banner and the column names are LOCALIZED
 *  (German prints "Aktive Verbindungen" over "Lokale Adresse"), so the one
 *  token to key on is `Proto`, which Windows does not translate. */
export function looksLikeWindowsNetstatOutput(text: string): boolean {
  return /^\s*Proto\s+\S/im.test(text);
}

/** /proc/net/tcp and tcp6 always carry their `sl local_address` header,
 *  even on the captured container where the file held no rows at all. */
export function looksLikeProcNetTcp(text: string): boolean {
  return /^\s*sl\s+local_address/im.test(text);
}

/**
 * Which family a listening socket is on, from the way its address is
 * written. A bare `*` is "dual": `ss` writes it for a wildcard bind that
 * answers on both families, and no source that writes it distinguishes
 * them — so it is reported as both rather than guessed as v4.
 */
export function familyOf(token: string, normalized: string): ListenSocket["family"] {
  if (normalized === "*") {
    return token.includes("0.0.0.0") ? "ipv4" : token.includes("[") ? "ipv6" : "dual";
  }
  return token.includes("[") || normalized.includes(":") ? "ipv6" : "ipv4";
}

const unowned = (address: string, port: number, family: ListenSocket["family"]): ListenSocket => ({
  address,
  port,
  family,
  owners: [],
  ownerKnown: false,
});

/**
 * Parse macOS/BSD `netstat -an -p tcp`.
 *
 * The state is the LAST field and is padded with trailing spaces, so rows
 * are selected by their final token rather than by column position. `tcp46`
 * is a real proto value — a dual-stack socket — and reporting it as ipv4
 * would lose the fact that it also answers on v6.
 */
export function parseBsdNetstat(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trimEnd();
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5) continue;
    if (tokens[tokens.length - 1] !== "LISTEN") continue;
    const proto = tokens[0] as string;
    if (!proto.startsWith("tcp")) continue;
    const local = splitDotPort(tokens[3] as string);
    if (local === null) continue;
    const family: ListenSocket["family"] =
      proto === "tcp46" ? "dual" : proto === "tcp6" ? "ipv6" : "ipv4";
    out.push(unowned(local.address, local.port, family));
  }
  return out;
}

/**
 * Parse Linux `ss -ltnp`.
 *
 * Two shapes have to be tolerated. Some builds print a leading `Netid`
 * column and some do not, so the first token is inspected rather than
 * assumed; and the `Process` column is ABSENT — not empty, absent — for a
 * socket whose owner this user may not inspect, which is the unknown-owner
 * case rather than an unowned socket.
 */
export function parseSsListen(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    let tokens = line.trim().split(/\s+/);
    if (/^(tcp|udp|raw|nl|unix|v_str)$/i.test(tokens[0] as string)) tokens = tokens.slice(1);
    if (tokens[0] !== "LISTEN") continue; // skips the header row too
    const localToken = tokens[3];
    if (localToken === undefined) continue;
    const local = splitColonPort(localToken);
    if (local === null) continue;
    const owners = parseSsUsers(tokens.slice(5).join(" "));
    out.push({
      address: local.address,
      port: local.port,
      family: familyOf(localToken, local.address),
      owners,
      ownerKnown: owners.length > 0,
    });
  }
  return out;
}

/** `users:(("nginx",pid=1200,fd=6),("nginx",pid=1201,fd=6))` — one socket,
 *  two processes. Both are reported; a shared listening socket is normal
 *  (pre-forking servers, an inherited fd) and picking one would be a guess. */
export function parseSsUsers(text: string): SocketOwner[] {
  const owners: SocketOwner[] = [];
  for (const match of text.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
    owners.push({
      pid: Number(match[2]),
      process: match[1] === "" ? null : (match[1] as string),
      user: null,
      uid: null,
    });
  }
  return owners;
}

/**
 * Parse Linux `netstat -ltnp` (GNU and busybox print the same columns).
 *
 * `PID/Program name` is `-` when the process cannot be read, which is the
 * unknown owner again. The local address is `:::9090` for a dual-stack
 * listener — three colons, and the reason every split here is on the LAST
 * one.
 */
export function parseLinuxNetstat(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 6) continue;
    const proto = tokens[0] as string;
    if (!/^tcp6?$/.test(proto)) continue;
    if (tokens[5] !== "LISTEN") continue;
    const localToken = tokens[3] as string;
    const local = splitColonPort(localToken);
    if (local === null) continue;
    const owners: SocketOwner[] = [];
    const pidProgram = tokens[6];
    if (pidProgram !== undefined && pidProgram !== "-") {
      const slash = pidProgram.indexOf("/");
      const pid = Number(slash < 0 ? pidProgram : pidProgram.slice(0, slash));
      owners.push({
        pid: Number.isInteger(pid) ? pid : null,
        process: slash < 0 ? null : pidProgram.slice(slash + 1),
        user: null,
        uid: null,
      });
    }
    out.push({
      address: local.address,
      port: local.port,
      // `tcp6` in the proto column, or an address with more than one colon.
      family: proto === "tcp6" || localToken.split(":").length > 2 ? "ipv6" : "ipv4",
      owners,
      ownerKnown: owners.length > 0,
    });
  }
  return out;
}

/**
 * Parse Windows `netstat -ano`.
 *
 * Two traps. First, a UDP row has no State column, so the row has one field
 * fewer and a positional parse reads the pid as the state; the pid is taken
 * from the END of the row instead. Second, the state word is LOCALISED —
 * German Windows prints `ABHÖREN` — so a listener is recognised by its
 * wildcard foreign address (`0.0.0.0:0`, `[::]:0`, `*:*`), with the English
 * word accepted as a shortcut. Matching only on "LISTENING" reports a
 * non-English machine as having no listeners at all.
 */
export function parseWindowsNetstat(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const raw of text.split("\n")) {
    const tokens = raw.replace(/\r$/, "").trim().split(/\s+/);
    if (tokens.length < 4) continue;
    const proto = (tokens[0] as string).toUpperCase();
    if (proto !== "TCP") continue; // UDP has no listening state to report
    const localToken = tokens[1] as string;
    const foreign = tokens[2] as string;
    const state = tokens.length >= 5 ? (tokens[3] as string) : undefined;
    const foreignPort = splitColonPort(foreign);
    const wildcardPeer = foreign === "*:*" || (foreignPort !== null && foreignPort.port === 0);
    if (!wildcardPeer && state?.toUpperCase() !== "LISTENING") continue;
    const local = splitColonPort(localToken);
    if (local === null) continue;
    const pid = Number(tokens[tokens.length - 1]);
    const known = Number.isInteger(pid);
    out.push({
      address: local.address,
      port: local.port,
      family: localToken.includes("[") || localToken.split(":").length > 2 ? "ipv6" : "ipv4",
      owners: known ? [{ pid, process: null, user: null, uid: null }] : [],
      ownerKnown: false, // a pid is not a name; tasklist supplies that
    });
  }
  return out;
}

/** Parse `tasklist /FO CSV /NH` into pid -> image name. Quoted CSV, five
 *  columns, and the memory column contains a comma INSIDE its quotes —
 *  which is why this is a quote-aware split and not `line.split(",")`. */
export function parseTasklistCsv(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    const fields = splitCsvRow(line);
    const name = fields[0];
    const pid = Number(fields[1]);
    if (name === undefined || !Number.isInteger(pid)) continue;
    if (!out.has(pid)) out.set(pid, name);
  }
  return out;
}

function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(field);
      field = "";
      continue;
    }
    field += ch;
  }
  fields.push(field);
  return fields;
}

export type LsofRecord = {
  readonly pid: number | null;
  readonly process: string | null;
  readonly user: string | null;
  readonly uid: number | null;
  readonly address: string;
  readonly port: number;
};

/**
 * Parse `lsof -F` field output.
 *
 * The format is one field per line, prefixed by its identifier, and it is
 * STATEFUL: a `p` line opens a process and its `c`/`u`/`L` fields apply to
 * every `f` (file) block under it until the next `p`. The column format is
 * easier to read but truncates COMMAND to nine characters — a real capture
 * from this machine turned `com.docker.backend` into `com.docke` — so the
 * field form is what runs first.
 */
export function parseLsofFields(text: string): LsofRecord[] {
  const out: LsofRecord[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  let user: string | null = null;
  let uid: number | null = null;
  let address: { address: string; port: number } | null = null;
  let isTcp = false;
  let isListen = false;

  const flush = (): void => {
    if (address !== null && isTcp && isListen) {
      out.push({ pid, process: command, user, uid, address: address.address, port: address.port });
    }
    address = null;
    isTcp = false;
    isListen = false;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    switch (tag) {
      case "p":
        flush();
        pid = Number.isInteger(Number(value)) ? Number(value) : null;
        command = null;
        user = null;
        uid = null;
        break;
      case "c":
        command = value === "" ? null : value;
        break;
      case "u":
        uid = Number.isInteger(Number(value)) ? Number(value) : null;
        break;
      case "L":
        user = value === "" ? null : value;
        break;
      case "f":
        flush();
        break;
      case "P":
        isTcp = value.toUpperCase() === "TCP";
        break;
      case "T":
        if (value.toUpperCase().startsWith("ST=")) {
          isListen = value.slice(3).toUpperCase() === "LISTEN";
        }
        break;
      case "n":
        address = splitColonPort(value);
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/**
 * Parse the column form of `lsof -nP -iTCP -sTCP:LISTEN`, used when an lsof
 * rejects `-F`.
 *
 * COMMAND may contain an escaped space (`Photo\x20App`), which keeps
 * whitespace splitting honest but leaves the escape in the name, so it is
 * decoded. The NAME column is `TCP 127.0.0.1:11434 (LISTEN)`, IPv6 in
 * brackets, and the command is truncated to nine characters by lsof itself —
 * nothing here can recover the rest, and the result says as much by
 * preferring the field parser.
 */
export function parseLsofColumns(text: string): LsofRecord[] {
  const out: LsofRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("COMMAND")) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 9) continue;
    if (!line.includes("(LISTEN)")) continue;
    const nameIndex = tokens.findIndex((t, i) => i >= 7 && t.toUpperCase() === "TCP");
    const target = nameIndex < 0 ? undefined : tokens[nameIndex + 1];
    if (target === undefined) continue;
    const parsed = splitColonPort(target);
    if (parsed === null) continue;
    const pid = Number(tokens[1]);
    out.push({
      pid: Number.isInteger(pid) ? pid : null,
      process: decodeLsofName(tokens[0] as string),
      user: tokens[2] as string,
      uid: null,
      address: parsed.address,
      port: parsed.port,
    });
  }
  return out;
}

/** lsof escapes non-printing bytes in COMMAND as \x20-style hex. */
export function decodeLsofName(name: string): string {
  return name.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Parse /proc/net/tcp or /proc/net/tcp6 — the last resort on a Linux host
 * with neither ss nor netstat installed.
 *
 * Addresses are hex in HOST byte order: `0100007F` is 127.0.0.1 on a
 * little-endian machine, and reading it big-endian gives 1.0.0.127, a
 * plausible-looking address that is simply wrong. `st` is the TCP state and
 * `0A` is LISTEN. The uid column is the owner's uid — not a pid and not a
 * name, so the socket is reported with a uid and an unknown process, which
 * is more than nothing and less than a guess.
 *
 * Both files must be read: on a container captured for the fixtures,
 * /proc/net/tcp was EMPTY while two listeners sat in /proc/net/tcp6, because
 * busybox `nc` binds dual-stack. Reading one file would have answered
 * "nothing is listening" with two servers running.
 */
export function parseProcNetTcp(text: string, family: "ipv4" | "ipv6"): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const raw of text.split("\n")) {
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length < 8) continue;
    if (!/^\d+:$/.test(tokens[0] as string)) continue; // header and blanks
    if ((tokens[3] as string).toUpperCase() !== "0A") continue;
    const localToken = tokens[1] as string;
    const at = localToken.lastIndexOf(":");
    if (at < 0) continue;
    const address =
      family === "ipv4" ? hexToIpv4(localToken.slice(0, at)) : hexToIpv6(localToken.slice(0, at));
    const port = Number.parseInt(localToken.slice(at + 1), 16);
    if (address === null || !Number.isInteger(port)) continue;
    const uid = Number(tokens[7]);
    out.push({
      address: normalizeAddress(address),
      port,
      family,
      owners: [{ pid: null, process: null, user: null, uid: Number.isInteger(uid) ? uid : null }],
      ownerKnown: false,
    });
  }
  return out;
}

/** `0100007F` -> `127.0.0.1`. Four bytes, least significant first. */
export function hexToIpv4(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const bytes = bytesOfWord(hex);
  return bytes.reverse().join(".");
}

/** 32 hex characters: four 32-bit words, each little-endian. */
export function hexToIpv6(hex: string): string | null {
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    bytes.push(...bytesOfWord(hex.slice(w * 8, w * 8 + 8)).reverse());
  }
  return formatIpv6(bytes);
}

function bytesOfWord(word: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 8; i += 2) bytes.push(Number.parseInt(word.slice(i, i + 2), 16));
  return bytes;
}

/** RFC 5952: lowercase, no leading zeroes, the longest run of zero groups
 *  compressed (leftmost on a tie), and a v4-mapped address printed in its
 *  dotted form so `::ffff:127.0.0.1` is recognisable as loopback. */
export function formatIpv6(bytes: ReadonlyArray<number>): string {
  if (bytes.length !== 16) return "";
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    return `::ffff:${bytes.slice(12).join(".")}`;
  }
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const length = i - start;
      if (length > bestLength) {
        bestLength = length;
        bestStart = start;
      }
      start = -1;
    }
  }
  const text = groups.map((g) => g.toString(16));
  if (bestLength < 2) return text.join(":");
  const head = text.slice(0, bestStart).join(":");
  const tail = text.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/**
 * Attach owners from one source to sockets from another.
 *
 * Matching is on normalised address and port, never on family: lsof reports
 * `IPv4` for a socket macOS netstat calls `tcp46`, and requiring them to
 * agree drops the owner from every dual-stack listener. A socket with no
 * match keeps `ownerKnown: false` and is STILL RETURNED — dropping it would
 * turn "this port is held by a process you may not inspect" into "this port
 * is free", which is the failure this package is built to avoid.
 */
export function joinOwners(
  sockets: ReadonlyArray<ListenSocket>,
  records: ReadonlyArray<LsofRecord>,
): ListenSocket[] {
  const byKey = new Map<string, SocketOwner[]>();
  for (const record of records) {
    const key = `${normalizeAddress(record.address)}:${record.port}`;
    const owners = byKey.get(key) ?? [];
    // One process can hold the same socket on several descriptors; report
    // each distinct pid once.
    if (!owners.some((o) => o.pid === record.pid)) {
      owners.push({
        pid: record.pid,
        process: record.process,
        user: record.user,
        uid: record.uid,
      });
    }
    byKey.set(key, owners);
  }
  return sockets.map((socket) => {
    if (socket.ownerKnown) return socket;
    const exact = byKey.get(`${socket.address}:${socket.port}`);
    // A wildcard listener is reported by lsof as `*:port` and by netstat as
    // `*.port`, but a socket bound to one address can also be reported by
    // lsof as the wildcard on some platforms, so a wildcard owner is
    // accepted for a specific address when nothing more exact matched.
    const owners = exact ?? byKey.get(`*:${socket.port}`);
    if (owners === undefined || owners.length === 0) return socket;
    return { ...socket, owners, ownerKnown: owners.some((o) => o.process !== null) };
  });
}

/** Stable order: port, then family, then address. Two calls against an
 *  unchanged machine must return the same bytes. */
export function sortSockets(sockets: ReadonlyArray<ListenSocket>): ListenSocket[] {
  return [...sockets].sort(
    (a, b) =>
      a.port - b.port || a.family.localeCompare(b.family) || a.address.localeCompare(b.address),
  );
}

/** Collapse rows that describe the same socket from one source. */
export function dedupeSockets(sockets: ReadonlyArray<ListenSocket>): ListenSocket[] {
  const seen = new Map<string, ListenSocket>();
  for (const socket of sockets) {
    const key = `${socket.address}:${socket.port}:${socket.family}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, socket);
      continue;
    }
    if (!existing.ownerKnown && socket.ownerKnown) seen.set(key, socket);
  }
  return [...seen.values()];
}
