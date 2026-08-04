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
