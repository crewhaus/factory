/**
 * The bootstrap: Home's own token and the single-use boot tickets, moved here from
 * hangar-server so the one package that decides who signs in also owns the owner's key.
 *
 * The token is minted at Home's first boot into `<hangarRoot>/token` (mode 0600, directory
 * 0700) and read back by the CLI on this computer. It is the owner only under the rules
 * `authenticate` applies (a direct loopback peer with no forwarding headers, or Home's own
 * socket), and it never reaches a browser: a boot ticket redirects to a single-use exchange
 * code instead. Comparison is constant-time over sha256 digests, so neither length nor
 * prefix leaks.
 *
 * `rotateBootstrap` replaces the token: the old digest is revoked, a new one recorded, and
 * every browser signed in with the old one signs in again.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { append, withLedgerLock } from "@crewhaus/control-records";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";
import { type SetUpResult, ensureAccessSetUp } from "./access";
import { sealTornLine, writeRevision } from "./files";
import { type Done, type Refusal, nextEpoch, refusal } from "./mutate";
import { accessLedger, accessPaths, signInLedger } from "./paths";
import type { CredentialRow } from "./records";
import { sha256Hex } from "./secrets";
import { type DeviceRow, type SessionRow, foldSignIn } from "./sign-in-records";
import { loadAccessSnapshot } from "./snapshot";

/**
 * The bootstrap token's file name under the Hangar root.
 *
 * First consumers: `crewhaus hangar status`, `open` and `qr`, which read it from disk.
 */
export const TOKEN_FILENAME = "token";

export type TokenSetup = {
  readonly token: string;
  /** Where the token lives on disk; undefined when supplied explicitly. */
  readonly tokenPath?: string;
  /** True when this boot minted a fresh token file. */
  readonly minted: boolean;
};

/**
 * Load or mint the boot token. An explicit value wins and writes nothing; otherwise
 * `<hangarRoot>/token` is read, or minted 0600.
 *
 * First consumer: Home's boot (`startHangarServer`).
 */
export function ensureToken(hangarRoot: string, explicit?: string): TokenSetup {
  if (explicit !== undefined && explicit.length > 0) {
    return { token: explicit, minted: false };
  }
  const tokenPath = join(hangarRoot, TOKEN_FILENAME);
  if (existsSync(tokenPath)) {
    const fromDisk = readFileSync(tokenPath, "utf8").trim();
    if (fromDisk.length > 0) return { token: fromDisk, tokenPath, minted: false };
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, tokenPath, minted: true };
}

/**
 * Constant-time equality over sha256 digests, so unequal lengths compare in the same
 * time as equal ones.
 *
 * First consumers: `authenticate` (the bootstrap before `access/` exists) and the
 * trusted-proxy secret check.
 */
export function tokenEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * How long a boot ticket lives. A ticket is 256 bits of CSPRNG, single use, and deleted
 * before its expiry is checked, so a value scraped from a process list is already spent.
 *
 * First consumer: the sign-in handle's boot tickets.
 */
export const BOOT_TICKET_TTL_MS = 120_000;

export type BootTickets = {
  /** Mint a ticket and return its path (`/boot/<nonce>`). */
  mint(nowMs: number): string;
  /** Consume a nonce; undefined when unknown, spent, or expired. */
  consume(nonce: string, nowMs: number): "ok" | undefined;
};

/**
 * One-time boot tickets: how a browser on this computer reaches sign-in without the
 * token ever appearing in a process argument list. `crewhaus hangar` opens
 * `…/boot/<nonce>`, an unauthenticated route that redirects ONCE and then forgets the
 * nonce.
 *
 * First consumer: the sign-in handle (`openSignIn`).
 */
export function createBootTickets(): BootTickets {
  const live = new Map<string, number>(); // nonce → expiry
  return {
    mint(nowMs) {
      for (const [n, exp] of live) if (exp <= nowMs) live.delete(n);
      const nonce = randomBytes(32).toString("hex");
      live.set(nonce, nowMs + BOOT_TICKET_TTL_MS);
      return `/boot/${nonce}`;
    },
    consume(nonce, nowMs) {
      const exp = live.get(nonce);
      if (exp === undefined) return undefined;
      live.delete(nonce); // single-use, spent even when expired
      return exp > nowMs ? "ok" : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export type RotateInput = {
  readonly localActor: string;
  /** Take the bootstrap off TCP: only `<hangarRoot>/home.sock` accepts it from now on. */
  readonly socketOnly?: boolean;
  /** Put it back on TCP (clears a socket-only bootstrap). */
  readonly tcp?: boolean;
  readonly now?: () => number;
};

export type RotateResult = {
  /** The new token's path; the token itself is never returned. */
  readonly tokenPath: string;
  readonly socketOnly: boolean;
  /** Sessions ended and devices revoked: everything signed in with the old key. */
  readonly endedSessions: number;
  readonly revokedDevices: number;
  /** Whether the access records were set up by this call. */
  readonly setUp: SetUpResult["created"];
};

/**
 * Replace Home's own token. Under the access lock: write a new 64-hex token to
 * `<hangarRoot>/token` (a temp file in the root at 0600, then a rename), revoke the old
 * bootstrap credential and record the new one (socket-only when asked; it stays so on a
 * later rotation unless `tcp` clears it), end every live session and revoke every device
 * key, and move the access revision once. Set-up runs first, so a Home whose access
 * records do not exist yet gets them. Refused for another user of this computer.
 *
 * First consumer: `crewhaus hangar rotate-token`.
 */
export async function rotateBootstrap(
  hangarRoot: string,
  input: RotateInput,
): Promise<Done<RotateResult> | Refusal> {
  if (input.socketOnly === true && input.tcp === true) {
    return refusal("invalid", "Choose socket-only or TCP, not both.");
  }
  const now = input.now ?? Date.now;
  const setup = await ensureAccessSetUp(hangarRoot, { localActor: input.localActor, now });
  if (!setup.ok) return setup;
  if (setup.result.localPrincipal !== setup.result.owner) {
    return refusal("not-authorized", "This Home belongs to another user on this computer.");
  }
  const owner = setup.result.owner;
  const paths = accessPaths();
  const lockLedger = accessLedger(hangarRoot, "principals");
  try {
    const locked = await withLedgerLock(
      lockLedger,
      async (): Promise<Done<RotateResult> | Refusal> => {
        const read = loadAccessSnapshot(hangarRoot);
        if (read.state !== "present") {
          return refusal(
            "unreadable",
            read.state === "absent"
              ? "The access records are missing."
              : `The access records cannot be read: ${read.reason}.`,
          );
        }
        const snapshot = read.snapshot;
        const ms = now();
        const at = new Date(ms).toISOString();
        const live = snapshot.tokens.filter(
          (row) => row.kind === "bootstrap" && row.state === "active",
        );
        const wasSocketOnly = live.some((row) => row.socketOnly === true);
        const socketOnly = input.tcp === true ? false : input.socketOnly === true || wasSocketOnly;
        const signIn = foldSignIn(hangarRoot);
        if (!signIn.ok) return refusal("unreadable", signIn.reason);

        // The new token first: a crash after it leaves the old digest active and the new
        // token refused, which a second rotation repairs; the reverse would lock the owner
        // out with no way to sign in.
        const token = randomBytes(32).toString("hex");
        const written = writeFileSafe(hangarRoot, paths.token, `${token}\n`, {
          overwrite: true,
          mode: 0o600,
        });
        if (!written.ok) return refusal("io-error", `Nothing was changed: ${written.reason}`);

        const rows: Array<{ ledger: "credentials" | "sessions" | "devices"; row: object }> = [];
        for (const row of live) {
          rows.push({
            ledger: "credentials",
            row: { ...row, state: "revoked", revokedAt: at, at, by: owner },
          });
        }
        const fresh: CredentialRow = {
          id: mintId("crd"),
          principal: owner,
          kind: "bootstrap",
          sha256: await sha256Hex(token),
          ...(socketOnly ? { socketOnly: true as const } : {}),
          state: "active",
          at,
          by: owner,
        };
        rows.push({ ledger: "credentials", row: fresh });
        const sessions = [...signIn.sessions.values()].filter((row) => row.state === "active");
        for (const row of sessions) {
          const ended: SessionRow = {
            ...row,
            state: "ended",
            endedAt: at,
            reason: "rotated",
            at,
            by: owner,
          };
          rows.push({ ledger: "sessions", row: ended });
        }
        const devices = [...signIn.devices.values()].filter((row) => row.state === "active");
        for (const row of devices) {
          const revoked: DeviceRow = { ...row, state: "revoked", revokedAt: at, at, by: owner };
          rows.push({ ledger: "devices", row: revoked });
        }
        for (const { ledger, row } of rows) {
          const target =
            ledger === "credentials"
              ? accessLedger(hangarRoot, "credentials")
              : signInLedger(hangarRoot, ledger);
          const rel = "file" in target.records ? target.records.file : "";
          const sealed = sealTornLine(hangarRoot, rel);
          if (!sealed.ok)
            return refusal("io-error", `The rotation was only partly recorded: ${sealed.reason}`);
          const appended = append(target, row as Record<string, unknown>);
          if (!appended.ok) {
            return refusal("io-error", `The rotation was only partly recorded: ${appended.reason}`);
          }
        }
        const epoch = nextEpoch(
          { root: hangarRoot, now, harnesses: () => [], domains: new Map() },
          snapshot.epoch,
          ms,
        );
        const moved = writeRevision(hangarRoot, epoch, at);
        if (!moved.ok)
          return refusal("io-error", `The rotation was only partly recorded: ${moved.reason}`);
        return {
          ok: true,
          result: {
            tokenPath: join(hangarRoot, paths.token),
            socketOnly,
            endedSessions: sessions.length,
            revokedDevices: devices.length,
            setUp: setup.result.created,
          },
          epoch,
          projections: { written: [], unchanged: [], failed: [] },
        };
      },
    );
    if ("path" in locked && locked.ok === false) {
      return refusal("io-error", `The access records could not be changed: ${locked.reason}`);
    }
    return locked as Done<RotateResult> | Refusal;
  } catch (err) {
    return refusal(
      "io-error",
      `The access records could not be locked: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
