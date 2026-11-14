/**
 * `crewhaus login --server <url>`: sign this computer in to a Home elsewhere with a short
 * code. The CLI asks Home to start a sign-in, shows the code and the page to type it on,
 * and waits while a member signed in to that Home allows it. The personal token it then
 * collects arrives sealed to a key this process made for that one request, and is kept
 * in the keychain (or a `0600` file under the Hangar root where there is none). No flag
 * takes a token. Plain `http://` to another computer needs `--allow-http`: the token would
 * cross the network unencrypted, and TLS is the proxy's job, not CrewHaus's.
 */
import { hostname } from "node:os";
import { EXIT_FOR_ERROR, OPERATIONS, PROTOCOL_ID } from "@crewhaus/control-contract";
import { createClient, makeSeal } from "@crewhaus/control-contract/http";
import { resolveHangarRoot } from "@crewhaus/harness-registry";
import { parseFamilyArgs as parseArgs } from "./family-args";
import { type SecretsStore, isLoopbackOrigin, originOf, remoteStore } from "./remote-homes";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "login",
  since: "0.9.0",
  bare: "device",
  sub: {
    device: { flags: { server: "value", "read-only": "boolean", "allow-http": "boolean" } },
  },
} as const satisfies CliFamily;

export type LoginDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly secrets?: SecretsStore;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Where the code is shown while it waits; everything else comes back as lines. */
  readonly stdout?: (text: string) => void;
  /** How long to wait for a member to allow it, at most. */
  readonly maxWaitMs?: number;
};

const USAGE = [
  "usage: crewhaus login --server <url> [--read-only] [--allow-http]",
  "  Signs this computer in to a Home elsewhere: it shows a code, and a member of that",
  "  Home allows it on Home's page. --read-only asks for a token that can only read.",
];

function parse(argv: readonly string[]) {
  const words = argv[0] === CLI_FAMILY.bare ? argv.slice(1) : argv;
  if (words[0] !== undefined && !words[0].startsWith("-")) {
    throw new Error(
      `unknown login verb "${words[0]}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const args = parseArgs("login", words, CLI_FAMILY.sub.device.flags);
  if (args.positional.length > 0)
    throw new Error(`login: unexpected argument "${args.positional[0]}"`);
  return {
    server: args.values.get("server")?.[0],
    readOnly: args.booleans.has("read-only"),
    allowHttp: args.booleans.has("allow-http"),
  };
}

/** What this computer calls itself on the page that allows it: a label, never authority. */
function clientName(): string {
  const host = hostname()
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 40);
  return host === "" ? "crewhaus CLI" : `crewhaus CLI on ${host}`;
}

export async function runLoginCommand(
  argv: readonly string[],
  deps: LoginDeps = {},
): Promise<{ readonly lines: readonly string[]; readonly exitCode: number }> {
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const fail = (line: string, exitCode: number) => ({ lines: [`login: ${line}`], exitCode });
  const flags = parse(argv);
  if (flags.server === undefined)
    return fail("name the Home with --server <url>", EXIT_FOR_ERROR.invalid);
  const parsed = originOf(flags.server);
  if ("reason" in parsed) return fail(parsed.reason, EXIT_FOR_ERROR.invalid);
  const { origin } = parsed;
  if (origin.startsWith("http:") && !isLoopbackOrigin(origin) && !flags.allowHttp) {
    return fail(
      `${origin} is not encrypted, so the token would cross the network in the clear. Use https, or pass --allow-http if this network is yours.`,
      EXIT_FOR_ERROR.invalid,
    );
  }
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const client = createClient({ baseUrl: origin, fetch: fetchImpl, operations: OPERATIONS });
  const found = await client.discover();
  if (!found.ok) {
    return fail(
      `${origin} did not answer as a Home: ${found.error.message}`,
      EXIT_FOR_ERROR[found.error.code] ?? EXIT_FOR_ERROR.unavailable,
    );
  }
  if (found.protocol !== PROTOCOL_ID || !found.signIn.methods.includes("device")) {
    return fail(
      `${origin} does not offer sign-in with a code (${PROTOCOL_ID}).`,
      EXIT_FOR_ERROR.unsupported,
    );
  }
  const startSeal = await makeSeal();
  const started = await client.call("auth.device.start", {
    body: {
      seal: startSeal.seal,
      clientName: clientName(),
      ...(flags.readOnly ? { readOnly: true } : {}),
    },
  });
  if (!started.ok) return fail(started.error.message, EXIT_FOR_ERROR[started.error.code] ?? 1);
  const answer = started.body as {
    issued: unknown;
    userCode: string;
    verificationUrl: string;
    intervalMs: number;
    expiresAt: string;
  };
  const pollRef = await startSeal.open(answer.issued, "auth.device.start");
  out(
    [
      `To sign in, open ${answer.verificationUrl} in a browser signed in to that Home,`,
      `and enter this code: ${answer.userCode}`,
      "Waiting for it to be allowed…",
      "",
    ].join("\n"),
  );
  let interval = Math.max(1000, answer.intervalMs);
  let waited = 0;
  const maxWait = deps.maxWaitMs ?? 10 * 60_000 + 30_000;
  const expired = fail(
    "the code expired before it was allowed. Run `crewhaus login` again.",
    EXIT_FOR_ERROR.invalid,
  );
  for (;;) {
    if (waited >= maxWait) return expired;
    await sleep(interval);
    waited += interval;
    const seal = await makeSeal();
    const polled = await client.call("auth.device.poll", { body: { pollRef, seal: seal.seal } });
    if (!polled.ok) {
      if (polled.error.code === "rate_limited") {
        interval = Math.max(interval, polled.error.retryAfterMs ?? interval + 5_000);
        continue;
      }
      return fail(polled.error.message, EXIT_FOR_ERROR[polled.error.code] ?? 1);
    }
    const body = polled.body as Record<string, unknown>;
    const state = body["state"];
    if (state === "pending") continue;
    if (state === "denied") return fail("the sign-in was denied.", EXIT_FOR_ERROR.forbidden);
    if (state === "expired") return expired;
    if (state === "consumed") {
      return fail(
        "this sign-in was already collected. Run `crewhaus login` again.",
        EXIT_FOR_ERROR.conflict,
      );
    }
    const token = await seal.open(body["issued"], "auth.device.poll");
    const hangarRoot = resolveHangarRoot(deps.env ?? process.env);
    await remoteStore(hangarRoot, deps.secrets).write({
      origin,
      token,
      ...(typeof body["credentialRef"] === "string"
        ? { credentialRef: body["credentialRef"] }
        : {}),
      ...(typeof body["expiresAt"] === "string" ? { expiresAt: body["expiresAt"] } : {}),
    });
    return {
      lines: [
        `Signed in to ${origin}${flags.readOnly ? " (read only)" : ""}. Try \`crewhaus api harnesses.list --server ${origin}\`.`,
      ],
      exitCode: 0,
    };
  }
}
