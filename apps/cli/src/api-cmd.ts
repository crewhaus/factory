/**
 * `crewhaus api <operation>`: call one operation of Home's versioned API by its id.
 *
 * On this computer it uses Home's own key over Home's socket (loopback where there is
 * none). With `--server <url>` it uses the personal token `crewhaus login` kept for that
 * Home. Paths are built from the operation table Home publishes, so the CLI keeps no
 * route map. It prints the answer as Home sent it (a masked field stays masked) and
 * exits 0 on success, or with the control band's code for the error Home named.
 *
 * Side-effect free on import; every I/O comes through `ApiDeps`, so a test drives it.
 */
import { readFileSync } from "node:fs";
import { EXIT_FOR_ERROR, OPERATIONS } from "@crewhaus/control-contract";
import { createClient } from "@crewhaus/control-contract/http";
import { resolveHangarRoot } from "@crewhaus/harness-registry";
import { parseFamilyArgs as parseArgs } from "./family-args";
import { type SecretsStore, localTransport, originOf, remoteStore } from "./remote-homes";
import type { CliFamily } from "./verbs";

/**
 * The `api` family: one sub-verb, run bare. The operation id is a positional, never a sub
 * key (ids hold a dot).
 */
export const CLI_FAMILY = {
  verb: "api",
  since: "0.9.0",
  bare: "call",
  sub: {
    call: {
      flags: {
        param: "values",
        "body-file": "value",
        query: "values",
        server: "value",
        json: "boolean",
      },
    },
  },
} as const satisfies CliFamily;

export type ApiDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly secrets?: SecretsStore;
  readonly readStdin?: () => Promise<string>;
};

/** What to print, and the exit: lines go to stdout on success and stderr otherwise. */
export type ApiResult = { readonly lines: readonly string[]; readonly exitCode: number };

const USAGE = [
  "usage: crewhaus api <operation> [--param k=v]... [--body-file <file>|-] [--query k=v]...",
  "                    [--server <url>] [--json]",
  "  Calls one operation of Home's API by its id, e.g. `crewhaus api harnesses.list`.",
  "  On this computer it uses Home's own key; --server uses the token `crewhaus login` kept.",
];

type Parsed = {
  readonly operation?: string;
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly bodyFile?: string;
  readonly server?: string;
  readonly json: boolean;
};

function pairs(values: readonly string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    if (at < 1) throw new Error(`api: --${flag} takes name=value (got "${value}")`);
    out[value.slice(0, at)] = value.slice(at + 1);
  }
  return out;
}

function parse(argv: readonly string[]): Parsed {
  const args = parseArgs("api", argv, CLI_FAMILY.sub.call.flags);
  // `crewhaus api call <operation>` and `crewhaus api <operation>` are the same.
  const rest = args.positional[0] === "call" ? args.positional.slice(1) : args.positional;
  if (rest.length > 1) throw new Error(`api: unexpected argument "${rest[1]}"`);
  const bodyFile = args.values.get("body-file")?.[0];
  const server = args.values.get("server")?.[0];
  return {
    ...(rest[0] !== undefined ? { operation: rest[0] } : {}),
    params: pairs(args.values.get("param") ?? [], "param"),
    query: pairs(args.values.get("query") ?? [], "query"),
    ...(bodyFile !== undefined ? { bodyFile } : {}),
    ...(server !== undefined ? { server } : {}),
    json: args.booleans.has("json"),
  };
}

/** The operation ids closest to a mistyped one. */
export function closestOperations(id: string, count = 3): string[] {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0] as number;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(
          (row[j] as number) + 1,
          (row[j - 1] as number) + 1,
          prev + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        prev = row[j] as number;
        row[j] = next;
      }
    }
    return row[b.length] as number;
  };
  return OPERATIONS.map((op) => op.id)
    .sort((x, y) => distance(id, x) - distance(id, y) || (x < y ? -1 : 1))
    .slice(0, count);
}

async function stdinText(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** Run `crewhaus api`. Argument errors throw plain Errors the dispatcher prints. */
export async function runApiCommand(
  argv: readonly string[],
  deps: ApiDeps = {},
): Promise<ApiResult> {
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  if (argv.length === 0) return { lines: USAGE, exitCode: EXIT_FOR_ERROR.invalid };
  const parsed = parse(argv);
  if (parsed.operation === undefined) {
    return {
      lines: ["api: name an operation, e.g. `crewhaus api harnesses.list`"],
      exitCode: EXIT_FOR_ERROR.invalid,
    };
  }
  const op = OPERATIONS.find((row) => row.id === parsed.operation);
  if (op === undefined) {
    // Every operation id holds a dot: a word without one is a sub-verb this family lacks.
    if (!parsed.operation.includes(".")) {
      throw new Error(
        `unknown api verb "${parsed.operation}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
      );
    }
    return {
      lines: [
        `api: there is no operation "${parsed.operation}". Did you mean: ${closestOperations(parsed.operation).join(", ")}?`,
      ],
      exitCode: EXIT_FOR_ERROR.invalid,
    };
  }
  let body: unknown;
  if (parsed.bodyFile !== undefined) {
    const text =
      parsed.bodyFile === "-"
        ? await (deps.readStdin ?? stdinText)()
        : readFileSync(parsed.bodyFile, "utf8");
    try {
      body = JSON.parse(text);
    } catch {
      return { lines: ["api: the body is not JSON"], exitCode: EXIT_FOR_ERROR.invalid };
    }
  } else if (op.method !== "GET") {
    body = {};
  }
  const env = deps.env ?? process.env;
  const hangarRoot = resolveHangarRoot(env);
  const fetchImpl = deps.fetch ?? fetch;
  let transport: {
    baseUrl: string;
    token?: string;
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
  };
  if (parsed.server !== undefined) {
    const origin = originOf(parsed.server);
    if ("reason" in origin)
      return { lines: [`api: ${origin.reason}`], exitCode: EXIT_FOR_ERROR.invalid };
    const kept = await remoteStore(hangarRoot, deps.secrets).read(origin.origin);
    if (kept === undefined) {
      return {
        lines: [
          `api: not signed in to ${origin.origin}. Run \`crewhaus login --server ${origin.origin}\` first.`,
        ],
        exitCode: EXIT_FOR_ERROR.unauthenticated,
      };
    }
    transport = {
      baseUrl: origin.origin,
      token: kept.token,
      fetch: (i, init) => fetchImpl(i, init),
    };
  } else {
    const local = localTransport(hangarRoot, fetchImpl);
    if ("reason" in local)
      return { lines: [`api: ${local.reason}`], exitCode: EXIT_FOR_ERROR.unavailable };
    transport = local;
  }
  const client = createClient({
    baseUrl: transport.baseUrl,
    ...(transport.token !== undefined ? { token: transport.token } : {}),
    fetch: transport.fetch,
  });
  const answer = await client.call(op.id, {
    params: parsed.params,
    query: parsed.query,
    ...(body !== undefined ? { body } : {}),
  });
  if (answer.ok) {
    return {
      lines: [parsed.json ? JSON.stringify(answer.body) : JSON.stringify(answer.body, null, 2)],
      exitCode: 0,
    };
  }
  const error = answer.error;
  return {
    lines: parsed.json
      ? [JSON.stringify({ error })]
      : [
          error.message,
          ...(error.verb !== undefined ? [`  The same from the CLI: ${error.verb}`] : []),
        ],
    exitCode: EXIT_FOR_ERROR[error.code] ?? 1,
  };
}
