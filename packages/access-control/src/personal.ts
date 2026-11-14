/**
 * Personal tokens: a member's own `chp_` token for a CLI or a script on another computer.
 * It acts as that member and never beyond: `authorize()` caps it at the member's grants,
 * refuses it anything that manages access, and keeps a read-only one at reading. It is
 * minted only when a sign-in a member allowed is collected, and the one access change it
 * may make is revoking itself.
 */
import { mintId } from "@crewhaus/control-contract";
import {
  type AccessContext,
  type Change,
  type Done,
  type Planning,
  type Refusal,
  refusal,
  runMutation,
} from "./mutate";
import type { CredentialRow } from "./records";
import { mintIssuedSecret, prefixHintOf, sha256Hex } from "./secrets";
import { type TokenView, tokenView } from "./views";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A personal token lasts 90 days.
 *
 * First consumer: device sign-in, which mints one when a sign-in is collected.
 */
export const PERSONAL_TOKEN_TTL_MS = 90 * DAY_MS;

export type PersonalIssue = {
  readonly token: TokenView;
  /** Shown once, sealed to the client that collects it. Only its sha256 is kept. */
  readonly secret: string;
};

/**
 * The rows that mint one personal token for `member`, or a refusal when `member` is not an
 * active member. For a change run with `own: true`, as the member who allowed it.
 */
export async function planPersonalToken(
  state: Planning,
  member: string,
  readOnly: boolean,
): Promise<Change<PersonalIssue> | Refusal> {
  const snapshot = state.snapshot;
  const who = snapshot?.principals.find((row) => row.id === member);
  if (
    snapshot === undefined ||
    who === undefined ||
    who.state !== "active" ||
    who.kind !== "member"
  ) {
    return refusal("not-found", "That member is not on this Home any more.");
  }
  const secret = mintIssuedSecret("personal");
  const row: CredentialRow = {
    id: mintId("crd", { now: state.now }),
    principal: member,
    kind: "personal",
    sha256: await sha256Hex(secret),
    prefixHint: prefixHintOf(secret),
    ...(readOnly ? { readOnly: true as const } : {}),
    expiresAt: new Date(state.now + PERSONAL_TOKEN_TTL_MS).toISOString(),
    state: "active",
    at: state.at,
    by: member,
  };
  return {
    rows: [{ kind: "credentials", row }],
    result: { token: { ...tokenView(snapshot, row, state.now), live: true }, secret },
  };
}

/**
 * Revoke one's own personal token: `crewhaus logout`, and the self-service row of the
 * token list. Refused for any token that is not the caller's own personal token.
 *
 * First consumers: Home's `access.tokens.revoke` on one's own token, and its tests.
 */
export function revokeOwnToken(
  ctx: AccessContext,
  principal: string,
  credential: string,
): Promise<Done<{ readonly token: TokenView }> | Refusal> {
  return runMutation<{ readonly token: TokenView }>(
    ctx,
    { principal },
    (state) => {
      const snapshot = state.snapshot;
      const row = snapshot?.tokens.find((t) => t.id === credential);
      if (snapshot === undefined || row === undefined || row.principal !== principal) {
        return refusal("not-found", "No token of yours has that id.");
      }
      if (row.kind !== "personal") {
        return refusal("not-authorized", "Only this Home's owner can revoke that token.");
      }
      if (row.state !== "active") return refusal("ended", "That token is already revoked.");
      const ended: CredentialRow = {
        ...row,
        state: "revoked",
        revokedAt: state.at,
        at: state.at,
        by: principal,
      };
      return {
        rows: [{ kind: "credentials", row: ended }],
        result: { token: tokenView(snapshot, ended, state.now) },
      };
    },
    { projections: false, own: true },
  );
}

/**
 * End one's own identity link: the self-service row of the link list. Refused for any link
 * that is not the caller's own.
 *
 * First consumer: Home's `access.links.revoke` on one's own link.
 */
export function unlinkOwn(
  ctx: AccessContext,
  principal: string,
  link: string,
): Promise<Done<{ readonly link: string }> | Refusal> {
  return runMutation<{ readonly link: string }>(
    ctx,
    { principal },
    (state) => {
      const row = state.snapshot?.links.find((l) => l.id === link);
      if (row === undefined || row.principal !== principal) {
        return refusal("not-found", "No link of yours has that id.");
      }
      if (row.state !== "active") return refusal("ended", "That link has already ended.");
      return {
        rows: [
          {
            kind: "links",
            row: { ...row, state: "revoked", revokedAt: state.at, at: state.at, by: principal },
          },
        ],
        result: { link },
      };
    },
    { projections: true, own: true },
  );
}
