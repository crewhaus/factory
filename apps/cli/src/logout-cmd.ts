/**
 * `crewhaus logout [--server <url>]`: end this computer's sign-in to a Home elsewhere.
 * The token is revoked in Home, as its own (a token may always end itself), then deleted
 * here. Offline, it is deleted here and stays valid until it is revoked in Home or ends.
 */
import { EXIT_FOR_ERROR, OPERATIONS } from "@crewhaus/control-contract";
import { createClient } from "@crewhaus/control-contract/http";
import { resolveHangarRoot } from "@crewhaus/harness-registry";
import { parseFamilyArgs as parseArgs } from "./family-args";
import { type SecretsStore, originOf, remoteStore } from "./remote-homes";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "logout",
  since: "0.9.0",
  bare: "revoke",
  sub: { revoke: { flags: { server: "value" } } },
} as const satisfies CliFamily;

export type LogoutDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly secrets?: SecretsStore;
};

const USAGE = [
  "usage: crewhaus logout [--server <url>]",
  "  Ends this computer's sign-in to a Home elsewhere: the token is revoked there and deleted here.",
];

export async function runLogoutCommand(
  argv: readonly string[],
  deps: LogoutDeps = {},
): Promise<{ readonly lines: readonly string[]; readonly exitCode: number }> {
  const words = argv[0] === CLI_FAMILY.bare ? argv.slice(1) : argv;
  if (words.includes("--help") || words.includes("-h")) return { lines: USAGE, exitCode: 0 };
  if (words[0] !== undefined && !words[0].startsWith("-")) {
    throw new Error(
      `unknown logout verb "${words[0]}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const args = parseArgs("logout", words, CLI_FAMILY.sub.revoke.flags);
  const server = args.values.get("server")?.[0];
  const store = remoteStore(resolveHangarRoot(deps.env ?? process.env), deps.secrets);
  let origin: string;
  if (server !== undefined) {
    const parsed = originOf(server);
    if ("reason" in parsed)
      return { lines: [`logout: ${parsed.reason}`], exitCode: EXIT_FOR_ERROR.invalid };
    origin = parsed.origin;
  } else {
    const origins = store.origins();
    if (origins.length === 0)
      return { lines: ["Not signed in to any Home elsewhere."], exitCode: 0 };
    if (origins.length > 1) {
      return {
        lines: [
          `logout: signed in to ${origins.length} Homes; say which with --server: ${origins.join(", ")}`,
        ],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    origin = origins[0] as string;
  }
  const kept = await store.read(origin);
  if (kept === undefined) {
    await store.remove(origin);
    return { lines: [`Not signed in to ${origin}.`], exitCode: 0 };
  }
  let revoked = false;
  let offline = false;
  if (kept.credentialRef !== undefined) {
    const client = createClient({
      baseUrl: origin,
      token: kept.token,
      fetch: deps.fetch ?? fetch,
      operations: OPERATIONS,
    });
    const answer = await client.call("access.tokens.revoke", {
      params: { crd: kept.credentialRef },
      body: {},
    });
    // A token Home no longer takes is already as good as revoked.
    revoked = answer.ok || answer.error.code === "unauthenticated";
    offline = !answer.ok && answer.status === 0;
  }
  await store.remove(origin);
  return {
    lines: [
      revoked
        ? `Signed out of ${origin}: the token is revoked and deleted from this computer.`
        : `Deleted the token for ${origin} from this computer. ${
            offline ? "Home could not be reached, so it" : "It"
          } stays valid until it is revoked in Home or it expires.`,
    ],
    exitCode: 0,
  };
}
