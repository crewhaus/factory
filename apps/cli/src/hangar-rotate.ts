/**
 * `crewhaus hangar rotate-token [--socket-only | --tcp]`: replace Home's own key.
 *
 * The new key is written to `<hangarRoot>/token` at 0600; the old one stops working at
 * once, on a running Home too (it reads the access records on the next request); every
 * browser that signed in is signed out and signs in again with a new link. With
 * `--socket-only` the key works only over `<hangarRoot>/home.sock`, which only this OS
 * user can open, so nothing that reaches Home's TCP port can use it, a forwarded port
 * included; `--tcp` puts it back. The key itself is never printed.
 */
import { hostname, userInfo } from "node:os";
import { type LocalIdentity, localActorOf, rotateBootstrap } from "@crewhaus/access-control";

export type RotateTokenInput = {
  readonly hangarRoot: string;
  readonly socketOnly: boolean;
  readonly tcp: boolean;
  readonly identity?: LocalIdentity;
  readonly now?: () => number;
};

function osIdentity(): LocalIdentity {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = process.env["USER"] ?? process.env["USERNAME"] ?? "";
  }
  return { username, hostname: hostname() };
}

/** Rotate, and say what changed. */
export async function rotateTokenVerb(
  input: RotateTokenInput,
): Promise<{ readonly lines: readonly string[]; readonly exitCode: 0 | 1 }> {
  if (input.socketOnly && input.tcp) {
    throw new Error("hangar rotate-token: choose --socket-only or --tcp, not both");
  }
  const done = await rotateBootstrap(input.hangarRoot, {
    localActor: localActorOf(input.identity ?? osIdentity()),
    ...(input.socketOnly ? { socketOnly: true } : {}),
    ...(input.tcp ? { tcp: true } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!done.ok) return { lines: [`crewhaus hangar rotate-token: ${done.reason}`], exitCode: 1 };
  const { result } = done;
  const lines = [
    ...(result.setUp.includes("owner")
      ? ["Access is set up for this Home, with you as its owner."]
      : []),
    `Home has a new key in ${result.tokenPath}; the old one no longer works.`,
    result.socketOnly
      ? "It works only over Home's socket on this computer (`--tcp` puts it back on Home's port)."
      : "It works only from this computer.",
    result.endedSessions + result.revokedDevices > 0
      ? "Every browser that was signed in is signed out: sign in again with `crewhaus hangar open`."
      : "No browser was signed in.",
  ];
  return { lines, exitCode: 0 };
}
