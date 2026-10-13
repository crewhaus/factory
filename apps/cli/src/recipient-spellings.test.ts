/**
 * 0.7.1 — a rule on a recipient decides on the place the tool reaches, not
 * on how the call spelled it.
 *
 * critic10 found SmsSend reading `(+1)5550100000` as +15550100000 while a
 * deny read it only as written. The audit that followed walked every builtin
 * that declares a `recipient` argument. For each one, this test takes the
 * spellings the TOOL reads as one destination, with the tool's own
 * normaliser, and checks that a deny on that destination fires on every one
 * of them through the real gate: the tool's schema and declaration
 * (`preparePermissionSubject`) and the engine (`evaluateWithReason`).
 *
 * A builtin that gains a recipient argument fails the first test until it is
 * audited here.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
import type { OperativeValue } from "@crewhaus/tool-permission-matcher";
import {
  hostSpellings,
  ipv4Address,
  normalizePhoneNumber,
} from "@crewhaus/tool-permission-matcher";
import { TOOL_REGISTRY } from "@crewhaus/tool-registry-manifest";
import { NON_CLI_TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const source = (pkg: string, file: string) => join(repoRoot, "packages", pkg, "src", file);

type Subject = (
  tool: unknown,
  input: unknown,
) =>
  | { ok: true; input: unknown; operativeValues?: ReadonlyArray<OperativeValue> }
  | { ok: false; reason: string };
type Tool = {
  name: string;
  readOnly?: boolean;
  destructive?: boolean;
  requiresSandbox?: boolean;
};

let preparePermissionSubject: Subject;
// Each tool's own reading of a destination, from the module that holds it.
let normalizeIpv4: (raw: string) => string | null;
let portTarget: (
  host: string,
  allowed: ReadonlyArray<string>,
  key: string,
) => { ok: boolean; dial?: string; resolve?: string; message?: string };
let normalizeDomain: (raw: string) => { ok: boolean; name?: string };
let isValidAddress: (raw: string) => boolean;
const tools = new Map<string, Tool>();

beforeAll(async () => {
  ({ preparePermissionSubject } = (await import(source("tool-executor", "index.ts"))) as {
    preparePermissionSubject: Subject;
  });
  ({ normalizeIpv4, portTarget } = await import(source("tool-proc", "lib/addr.ts")));
  ({ normalizeDomain } = await import(source("tool-notify", "lib/dns-records.ts")));
  ({ isValidAddress } = await import(source("tool-notify", "lib/mime.ts")));
  for (const [pkg, names] of [
    ["tool-notify", ["smsSend", "pushNotify", "emailSend", "chatPost", "chatUpdate"]],
    ["tool-notify", ["deliverabilityCheck"]],
    ["tool-http", ["dnsLookup", "tlsInspect"]],
    ["tool-proc", ["waitForPort"]],
    ["tool-discovery", ["federationDiscover"]],
    ["tool-evm-tx", ["evmSendTransaction"]],
    ["tool-codehost", ["issueCreate"]],
  ] as const) {
    const mod = (await import(source(pkg, "index.ts"))) as Record<string, Tool>;
    for (const name of names) tools.set(name, mod[name] as Tool);
  }
}, 60_000);

/** The gate's decision on a call, under a deny on `arg` and a bare allow. */
function denied(key: string, input: unknown, arg: string): string {
  const tool = tools.get(key) as Tool;
  const subject = preparePermissionSubject(tool, input);
  if (!subject.ok) return `invalid: ${subject.reason}`;
  const rules: RuleSet = {
    ...emptyRuleSet,
    yaml: (
      [
        ["alwaysDeny", `${tool.name}(${arg})`],
        ["alwaysAllow", tool.name],
      ] as Array<[PermissionRule["type"], string]>
    ).map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
  };
  return evaluateWithReason(
    {
      toolName: tool.name,
      input: subject.input,
      ...(subject.operativeValues !== undefined
        ? { operativeValues: subject.operativeValues }
        : {}),
      readOnly: tool.readOnly === true,
      destructive: tool.destructive === true,
      requiresSandbox: tool.requiresSandbox === true,
    },
    "default",
    rules,
    { sandboxAvailable: false },
  ).decision;
}

/** Every IPv4 form of an address: one to four parts, each decimal, octal or hex. */
function ipv4Forms(address: string): string[] {
  const o = address.split(".").map(Number) as [number, number, number, number];
  const spell = (n: number): string[] => [
    String(n),
    `0${n.toString(8)}`,
    `0x${n.toString(16)}`,
    `0X${n.toString(16).toUpperCase()}`,
    `00${n}`,
  ];
  const combos = (parts: number[]): string[] =>
    parts.reduce<string[]>(
      (acc, n) => acc.flatMap((a) => spell(n).map((s) => (a === "" ? s : `${a}.${s}`))),
      [""],
    );
  const [a, b, c, d] = o;
  return [
    ...combos([a, b, c, d]),
    ...combos([a, b, c * 256 + d]),
    ...combos([a, b * 65536 + c * 256 + d]),
    ...combos([((a * 256 + b) * 256 + c) * 256 + d]),
  ];
}

const FULLWIDTH = (s: string) =>
  [...s]
    .map((ch) => (/[a-z]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch))
    .join("");

/** Spellings of a domain the IDNA reading folds: case, width, dots, a soft hyphen, NFD. */
function domainForms(name: string): string[] {
  const out = new Set<string>([name, name.toUpperCase(), `${name}.`, ` ${name} `]);
  out.add(FULLWIDTH(name));
  for (const dot of ["。", "．", "｡"]) out.add(name.split(".").join(dot));
  for (let p = 1; p < name.length; p++) out.add(`${name.slice(0, p)}­${name.slice(p)}`);
  out.add(name.normalize("NFD"));
  out.add(FULLWIDTH(name).toUpperCase());
  return [...out];
}

type Audit = {
  /** What the tool acts on for this spelling, by its own reading, or null when it refuses it. */
  readonly reads: (spelling: string) => string | null;
  readonly input: (spelling: string) => unknown;
  readonly spellings: () => string[];
};

const justified = { justification: "on task" };
const LISTED_PORT_HOSTS = ["10.0.0.5", "93.184.216.34", "db.internal", "fd00::5"];
/** IPv6 spellings of loopback WaitForPort probes with no list. */
const V6_LOOPBACK = [
  "::1",
  "0::1",
  "::ffff:127.0.0.1",
  "::FFFF:127.0.0.1",
  "0:0:0:0:0:ffff:127.0.0.1",
  "::ffff:7f00:0001",
];
/** The unspecified address, which WaitForPort dials as 127.0.0.1 or ::1. */
const UNSPECIFIED = [
  "0.0.0.0",
  "0",
  "0x0",
  "0.0",
  "00.0.0.0",
  "::ffff:0.0.0.0",
  "::",
  "::0",
  "0::0",
  "0:0:0:0:0:0:0:0",
];
/**
 * IPv6 spellings WaitForPort refuses: an IPv4 part with a leading zero is
 * octal to its parser and decimal to macOS's resolver, and the URL parser a
 * rule reads a host with refuses it.
 */
const NO_ONE_READING = [
  "::ffff:127.0.0.01",
  "::ffff:127.000.000.001",
  "::ffff:0177.0.0.1",
  "::0:0:0:0:0:0:0:1",
];
const chat = (channel: string) => ({
  platform: "slack",
  apiBaseUrl: "https://slack.com/api",
  tokenEnv: "SLACK_BOT_TOKEN",
  channel,
  ...justified,
});
const sms: Audit = {
  reads: (s) => normalizePhoneNumber(s),
  input: (s) => ({ provider: "gw", to: s, body: "x", ...justified }),
  spellings: () => ["+15550100000", "(+1)5550100000", "-+15550100000", "+1 (555) 010-0000"],
};

// keyed by builtin key; the codehost repository tools share one reading
const AUDITED: Readonly<Record<string, Audit>> = {
  smsSend: sms,
  pushNotify: {
    reads: (s) => (s.trim() === "" ? null : s.trim()),
    input: (s) => ({ provider: "gw", to: s, body: "x", ...justified }),
    spellings: () => ["topic:ops-db", " topic:ops-db", "topic:ops-db\n", " topic:ops-db　"],
  },
  emailSend: {
    reads: (s) => (isValidAddress(s) ? s.toLowerCase() : null),
    input: (s) => ({
      from: { address: "bot@corp.example" },
      to: [{ address: s }],
      subject: "s",
      text: "t",
      host: "smtp.corp.example",
      date: "2026-10-12T00:00:00Z",
      ...justified,
    }),
    spellings: () => ["ceo@corp.example", "CEO@corp.example", "ceo@CORP.EXAMPLE"],
  },
  chatPost: {
    reads: (s) => s,
    input: (s) => ({ ...chat(s), text: "x" }),
    spellings: () => ["C0123", "general"],
  },
  chatUpdate: {
    reads: (s) => s,
    input: (s) => ({ ...chat(s), messageId: "1712.0001", text: "x" }),
    spellings: () => ["C0123"],
  },
  deliverabilityCheck: {
    reads: (s) => {
      const d = normalizeDomain(s);
      return d.ok ? (d.name as string) : null;
    },
    input: (s) => ({ domain: s }),
    spellings: () =>
      ["example.com", "münchen.de", "mail.bücher.example", "xn--mnchen-3ya.de"].flatMap(
        domainForms,
      ),
  },
  dnsLookup: {
    reads: (s) => s.trim().toLowerCase(),
    input: (s) => ({ name: s }),
    spellings: () => ["api.example.com", "API.Example.COM", " api.example.com\t"],
  },
  tlsInspect: {
    reads: (s) => s.trim().toLowerCase(),
    input: (s) => ({ host: s }),
    spellings: () => ["api.example.com", "API.Example.COM", " api.example.com "],
  },
  waitForPort: {
    // The address it dials, or the listed name it looks up.
    reads: (s) => {
      if (!/^[A-Za-z0-9._:-]+$/.test(s)) return null;
      const target = portTarget(s, LISTED_PORT_HOSTS, "tool_config.proc.wait_for_port_hosts");
      if (!target.ok) return null;
      return target.dial ?? (target.resolve as string).toLowerCase();
    },
    input: (s) => ({ port: 5432, host: s, timeoutMs: 1000 }),
    spellings: () => [
      ...ipv4Forms("10.0.0.5"),
      ...ipv4Forms("93.184.216.34"),
      ...ipv4Forms("127.0.0.1"),
      "10.0.0.08".replace("08", "05"),
      "10.0.0.08",
      "fd00::5",
      "FD00::5",
      "fd00:0:0:0:0:0:0:0005",
      "db.internal",
      "DB.Internal",
      "localhost",
      ...V6_LOOPBACK,
      // dialled as 127.0.0.1 or ::1 by the tool itself
      ...UNSPECIFIED,
      // refused by the tool: no one reading
      ...NO_ONE_READING,
    ],
  },
  federationDiscover: {
    // The host of the URL it fetches; one the URL parser refuses reaches nothing.
    reads: (s) => {
      if (!/^[a-zA-Z0-9.-]+$/.test(s)) return null;
      try {
        return new URL(`https://${s}/`).hostname;
      } catch {
        return null;
      }
    },
    input: (s) => ({ peers: [s] }),
    spellings: () => [
      ...ipv4Forms("93.184.216.34"),
      "peer.example.org",
      "PEER.Example.org",
      "peer.example.org.",
    ],
  },
  evmSendTransaction: {
    reads: (s) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null),
    input: (s) => ({ walletId: "w", to: s, data: "0x", ...justified }),
    spellings: () => [
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    ],
  },
  issueCreate: {
    reads: (s) => s,
    input: (s) => {
      const [owner, repo] = s.split("/");
      return { owner, repo, title: "t", ...justified };
    },
    spellings: () => ["acme/app", "ACME/App"],
  },
};

/** Recipient tools that read the codehost repository exactly as issueCreate does. */
const SAME_AS_ISSUE_CREATE = [
  "issueComment",
  "issueUpdate",
  "prComment",
  "prCreate",
  "prReviewSubmit",
  "prUpdate",
  "releaseCreate",
];

/**
 * Read as written, a known limitation (CHANGELOG, Known limitations): the
 * tools read `alpine` as Docker Hub's `docker.io/library/alpine`, a
 * reference grammar no rule reading shares.
 */
const READ_AS_WRITTEN = ["containerImageInspect", "containerImageTags"];

describe("every recipient a builtin declares is audited here", () => {
  test("the audited, the ones that read like them, and the known limitation cover them all", () => {
    const declared = Object.values({ ...TOOL_REGISTRY, ...NON_CLI_TOOL_FLAGS })
      .filter((e) => (e.operativeArgs ?? []).some((a) => a.kind === "recipient"))
      .map((e) => e.key)
      .sort();
    expect(declared).toEqual(
      [...Object.keys(AUDITED), ...SAME_AS_ISSUE_CREATE, ...READ_AS_WRITTEN].sort(),
    );
  });
});

describe("a deny on the place a recipient tool reaches fires on every spelling the tool reads as it", () => {
  for (const [key, audit] of Object.entries(AUDITED)) {
    test(key, () => {
      const rows = audit.spellings().map((s) => ({ s, place: audit.reads(s) }));
      const read = rows.filter((r): r is { s: string; place: string } => r.place !== null);
      const missed = read
        .map(({ s, place }) => ({ s, place, got: denied(key, audit.input(s), place) }))
        .filter((r) => r.got !== "deny");
      expect({ key, missed }).toEqual({ key, missed: [] });
      // The sweep reached the tool: some spelling is one it acts on.
      expect(read.length).toBeGreaterThan(0);
    }, 30_000);
  }

  test("a deny on another place does not fire", () => {
    expect(denied("waitForPort", { port: 1, host: "10.5", timeoutMs: 1 }, "10.0.0.6")).toBe(
      "allow",
    );
    expect(denied("deliverabilityCheck", { domain: "münchen.de" }, "berlin.de")).toBe("allow");
    expect(denied("smsSend", sms.input("(+1)5550100000"), "+15550100001")).toBe("allow");
  });
});

describe("the gate reads an IPv4 address as WaitForPort does", () => {
  test("ipv4Address and tool-proc's normalizeIpv4 agree on every form and on what is not one", () => {
    const inputs = new Set<string>([
      ...ipv4Forms("10.0.0.5"),
      ...ipv4Forms("255.255.255.255"),
      ...ipv4Forms("0.0.0.0"),
      ...ipv4Forms("1.2.3.4"),
      "10.0.0.08",
      "08.09.010.0x",
      "256.1",
      "1.256.0.0",
      "4294967296",
      "0x100000000",
      "1.2.3.4.5",
      "1..2",
      ".1.2.3",
      "1.2.3.",
      " 10.5 ",
      "",
      "0x",
      "x1",
      "1e3",
      "+1",
      "-1",
    ]);
    // Every short string over the characters the forms are written in.
    let layer = [""];
    for (let n = 1; n <= 4; n++) {
      layer = layer.flatMap((s) => ["0", "1", "8", "x", "f", "."].map((c) => s + c));
      for (const s of layer) inputs.add(s);
    }
    const disagree = [...inputs].filter((s) => (ipv4Address(s) ?? null) !== normalizeIpv4(s));
    expect({ checked: inputs.size, disagree }).toEqual({ checked: 4682, disagree: [] });
  }, 30_000);
});

describe("WaitForPort dials what the gate reads", () => {
  // An IPv4 part with a leading zero is octal to WaitForPort's parser,
  // decimal to macOS's resolver and invalid to the URL parser the gate reads
  // a host with. `::ffff:0177.0.0.1` was classified as loopback and dialled
  // as written, and macOS reached 177.0.0.1; `::ffff:127.0.0.01` reached
  // 127.0.0.1 there past a deny on it.
  test("each address it dials is one the system dials as is and the gate reads the host as; a spelling with no one reading is refused", () => {
    // An embedded IPv4 part in decimal, with leading zeros, and in octal digits.
    const parts = (n: number) => [String(n), `0${n}`, `00${n}`, `0${n.toString(8)}`];
    const spellings = new Set<string>([
      ...V6_LOOPBACK,
      ...UNSPECIFIED,
      ...NO_ONE_READING,
      "localhost",
      "127.1",
      "fd00::5",
      "db.internal",
    ]);
    for (const [a, d] of [
      [127, 1],
      [0, 0],
      [10, 5],
      [177, 1],
    ] as const) {
      for (const pa of parts(a)) {
        for (const pd of parts(d)) {
          for (const prefix of ["::ffff:", "::", "0:0:0:0:0:ffff:", "64:ff9b::"]) {
            spellings.add(`${prefix}${pa}.0.0.${pd}`);
          }
        }
      }
    }
    const outcome = { dialled: 0, looked_up: 0, no_one_reading: 0, not_listed: 0 };
    const wrong: string[] = [];
    for (const s of spellings) {
      const target = portTarget(s, LISTED_PORT_HOSTS, "tool_config.proc.wait_for_port_hosts");
      // An IPv6 spelling whose IPv4 part has a part with a leading zero.
      const quad = s.includes(":") ? /(\d+(?:\.\d+){3})$/.exec(s)?.[1] : undefined;
      const leadingZero =
        NO_ONE_READING.includes(s) || (quad?.split(".").some((p) => /^0\d/.test(p)) ?? false);
      if (!target.ok) {
        const why = (target.message ?? "").includes("resolvers read")
          ? "no_one_reading"
          : "not_listed";
        outcome[why]++;
        if (leadingZero !== (why === "no_one_reading")) wrong.push(`${s} refused: ${why}`);
        continue;
      }
      if (leadingZero) wrong.push(`${s} accepted`);
      if (target.resolve !== undefined) {
        outcome.looked_up++;
        continue;
      }
      outcome.dialled++;
      const dial = target.dial as string;
      // The system dials the string as is (no resolver reads it again), and
      // it is one of the spellings a deny or ask rule reads the host as.
      if (dial !== "localhost" && isIP(dial) === 0) wrong.push(`${s} dials ${dial}`);
      if (!hostSpellings(s).includes(dial)) wrong.push(`${s}: the gate does not read ${dial}`);
    }
    expect({ wrong }).toEqual({ wrong: [] });
    expect(outcome).toEqual({ dialled: 23, looked_up: 1, no_one_reading: 154, not_listed: 9 });
  });
});
