/**
 * Bearer-token auth for the loopback manager API.
 *
 * The token is supplied by the caller (`opts.token`) or minted at boot into
 * `<hangarRoot>/token` (mode 0600, dir 0700) so `crewhaus hangar open` can
 * read it back and hand it to the browser as a URL FRAGMENT. Every `/api`
 * route requires `Authorization: Bearer <token>`; `/healthz` and the static
 * UI shell (which contains no harness data and must load before the client
 * has stored the fragment token) do not. Comparison is constant-time over
 * sha256 digests so neither length nor prefix leaks. No cookies anywhere —
 * no cookie means no CSRF surface.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKEN_FILENAME = "token";

export type TokenSetup = {
  readonly token: string;
  /** Where the token lives on disk; undefined when supplied via options. */
  readonly tokenPath?: string;
  /** True when this boot minted a fresh token file. */
  readonly minted: boolean;
};

/** Load or mint the boot token. An explicit `token` option wins and writes
 *  nothing; otherwise `<hangarRoot>/token` is read, or minted 0600. */
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

/** Constant-time token equality (over sha256 digests, so unequal lengths
 *  compare in the same time as equal ones). */
export function tokenEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * One-time boot tickets — how the token reaches the browser without ever
 * appearing in a process argument list.
 *
 * `crewhaus hangar` opens a URL in the user's browser. Passing
 * `…/#t=<token>` on that command line would publish the token to every
 * process table reader on the machine (argv is world-readable on Linux and
 * visible to `ps` on macOS). Instead the CLI opens `…/boot/<nonce>`: an
 * unauthenticated route that redirects ONCE to the fragment form and then
 * forgets the nonce. The nonce is 256 bits of CSPRNG, single-use, and
 * short-lived, so a leaked argv yields a value that is already spent.
 */
export const BOOT_TICKET_TTL_MS = 120_000;

export type BootTickets = {
  /** Mint a ticket and return its path (`/boot/<nonce>`). */
  mint(nowMs: number): string;
  /** Consume a nonce; undefined when unknown, spent, or expired. */
  consume(nonce: string, nowMs: number): "ok" | undefined;
};

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

/** True when the request carries `Authorization: Bearer <expected>`. */
export function isAuthorized(req: Request, expected: string): boolean {
  const header = req.headers.get("authorization");
  if (header === null) return false;
  const [scheme, ...rest] = header.split(" ");
  if (scheme === undefined || scheme.toLowerCase() !== "bearer") return false;
  const presented = rest.join(" ").trim();
  if (presented.length === 0) return false;
  return tokenEquals(presented, expected);
}
