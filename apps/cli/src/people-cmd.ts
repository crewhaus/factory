/**
 * `crewhaus people`: people profiles, kept in an encrypted vault under the Hangar root,
 * outside every harness (#521). Every verb works with Home stopped and acts as the
 * local OS user's principal, the way `crewhaus access` does.
 *
 * Side-effect-free on import, in `access-cmd.ts`'s shape: the environment, the clock,
 * the OS identity, stdin, the credential store and the registry are injected, and each
 * verb returns lines and an exit code. Bad arguments throw plain `Error`s; the entry
 * file routes them through `die()`.
 *
 * Reads (`keys`, `list`, `show`, `review <psn>`, `export --dry-run`, `activity`,
 * `erase --dry-run`) set nothing up and write nothing. Every change is a command whose
 * receipt is written to Home's workspace ledger before the vault changes. A note's words
 * and a profile's name are typed or piped in, never put on the command line.
 */
import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type LocalIdentity,
  ensureAccessSetUp,
  loadAccessSnapshot,
  localActorOf,
  localPrincipalOf,
  openAccess,
} from "@crewhaus/access-control";
import {
  type ErasureResidue,
  PEOPLE_PURPOSES,
  type PeoplePurpose,
  type PersonActivityRow,
  type PersonKind,
  VAULT_CUSTODIES,
  type VaultCustody,
  isId,
} from "@crewhaus/control-contract";
import { currentLocalIdentity, wireControl, withOwnStartTime } from "@crewhaus/control-service";
import { type HangarRegistry, openHangarRegistry } from "@crewhaus/harness-registry";
import { createProcessOps } from "@crewhaus/harness-supervisor";
import {
  type PeopleAdmin,
  type ReceiptsPort,
  type Refused,
  SAVED_KEY_ROTATION,
  type StoredClaim,
  createPeopleAdmin,
} from "@crewhaus/people-service";
import {
  KEY_HEX_RE,
  SPACE_KEY_ENV,
  type SecretsPort,
  type Vault,
  openVault,
} from "@crewhaus/people/vault";
import { resolveHangarRoot } from "./hangar-cmd";
import type { CliFamily } from "./verbs";

export type PeopleCommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
};

export type PeopleCommandOptions = {
  /** Environment for the Hangar root, the registry and the environment key. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms); injected by tests. */
  readonly now?: () => number;
  /** The OS user acting; this process's user by default. */
  readonly identity?: LocalIdentity;
  /** The next line typed or piped in, `undefined` at the end. Defaults to stdin. */
  readonly stdin?: () => Promise<string | undefined>;
  /** Whether a person is typing: prompts are shown only then. Defaults to stdin's own answer. */
  readonly isTTY?: boolean;
  /**
   * Whether stdin is a file redirected in (`< new.key`), not a pipe. A new key kept in an
   * environment variable is read only from a saved file or typed twice. Defaults to stdin's
   * own answer; `undefined` when it cannot be told.
   */
  readonly stdinIsFile?: boolean;
  /**
   * Stops what is typed from showing, and returns what turns it back on; `undefined` when
   * this terminal cannot. Defaults to `stty -echo` on POSIX.
   */
  readonly hideInput?: () => (() => void) | undefined;
  /** Where prompts, the plan before an erasure and notices go. Defaults to stderr. */
  readonly prompt?: (text: string) => void;
  /** The OS credential store; `Bun.secrets` by default. */
  readonly secrets?: SecretsPort;
  /** Opens the registry for reading; tests inject one. Its writes are always turned off. */
  readonly openRegistry?: (env: Readonly<Record<string, string | undefined>>) => HangarRegistry;
};

const PEOPLE_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus people init [--custody keychain|environment|file] [--backup-days <n>]",
  "                                   set profiles up on this computer, and where their key is kept",
  "  crewhaus people keys [--rotate] [--json]",
  "                                   where the key is kept; --rotate replaces it",
  "  crewhaus people list [--json]    the profiles you own, look after or were shown",
  "  crewhaus people add --kind personal|audience|synthetic [--describes self|someone-else]",
  "       [--basis <b>] [--variation uniform|mixed|unknown] [--size <n>]",
  "                                   add a profile; its name is typed or piped in",
  "  crewhaus people show <psn_…> [--json]",
  "                                   what a profile says, and what needs review",
  "  crewhaus people set <psn_…> [--off-limits <area>]... [--allow <area>]...",
  "       [--viewer <prn_…>]... [--remove-viewer <prn_…>]... [--rename]",
  "                                   change a profile; a new name is typed or piped in",
  "  crewhaus people note <psn_…> --area <area> [--type <t>] [--purpose <p>]...",
  "       [--sensitivity <s>] [--confidence <c>] [--review-by <yyyy-mm-dd>]",
  "                                   add a note; its words, then when it applies, are typed or piped in",
  "  crewhaus people edit <pcl_…> [--expect <revision>]",
  "                                   change a note's words",
  "  crewhaus people review <psn_…>   the notes waiting for you",
  "  crewhaus people review <pcl_…> --as keep|reject|reopen|narrow|merge [--purpose <p>]... [--into <pcl_…>]",
  "  crewhaus people export <psn_…> [--out <file>] [--area <a>]... [--purpose <p>]...",
  "       [--include-sensitive] [--no-rejected] [--summary] [--dry-run] [--force]",
  "  crewhaus people activity <psn_…> [--json] [--limit <n>]",
  "  crewhaus people erase <psn_…> [--dry-run]",
  "                                   the dry run lists what goes and what stays; the real run asks",
  "                                   for the profile's name",
  "",
  "  Profiles are kept encrypted beside Home's own files, never in a harness. No harness can",
  "  use a profile yet. Kinds: personal, audience (a group), synthetic (a made-up persona).",
  "  Purposes (every one when none is given): communication, accessibility, scheduling,",
  "  recommendations, decision-support, drafting, learning-support, research-context, simulation.",
];

/**
 * The `people` family in the CLI's verb inventory (`verbs.ts`): each sub-verb and the
 * flags its parser takes. A `values` flag may be repeated; a `value` flag is given once.
 * Every `parseArgs` call below reads its flags from here, and the key order is the order
 * the unknown-verb message lists them in. No flag takes a note's words or a name.
 */
export const CLI_FAMILY = {
  verb: "people",
  since: "0.9.0",
  sub: {
    init: { flags: { custody: "value", "backup-days": "value" } },
    keys: { flags: { rotate: "boolean", json: "boolean" } },
    list: { flags: { json: "boolean" } },
    add: {
      flags: {
        kind: "value",
        describes: "value",
        basis: "value",
        variation: "value",
        size: "value",
      },
    },
    show: { flags: { json: "boolean" } },
    set: {
      flags: {
        "off-limits": "values",
        allow: "values",
        viewer: "values",
        "remove-viewer": "values",
        rename: "boolean",
      },
    },
    note: {
      flags: {
        area: "value",
        type: "value",
        purpose: "values",
        sensitivity: "value",
        confidence: "value",
        "review-by": "value",
      },
    },
    edit: { flags: { expect: "value" } },
    review: { flags: { as: "value", purpose: "values", into: "value" } },
    export: {
      flags: {
        out: "value",
        area: "values",
        purpose: "values",
        "include-sensitive": "boolean",
        "no-rejected": "boolean",
        summary: "boolean",
        "dry-run": "boolean",
        force: "boolean",
      },
    },
    activity: { flags: { json: "boolean", limit: "value" } },
    erase: { flags: { "dry-run": "boolean" } },
  },
} as const satisfies CliFamily;

// ---------------------------------------------------------------------------
// Argument parsing (access-cmd posture: throw plain Errors)
// ---------------------------------------------------------------------------

type FlagKind = "value" | "values" | "boolean";
type FlagSpec = Readonly<Record<string, FlagKind>>;

type Args = {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
};

function parseArgs(verb: string, argv: readonly string[], spec: FlagSpec): Args {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) {
      const known = Object.keys(spec).map((key) => `--${key}`);
      throw new Error(
        `people ${verb}: unknown flag "${arg}"${known.length > 0 ? ` (expected: ${known.join(", ")})` : ""}`,
      );
    }
    if (kind === "boolean") {
      booleans.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`people ${verb}: ${arg} needs a value`);
    i++;
    const list = values.get(name) ?? [];
    if (kind === "value" && list.length > 0) {
      throw new Error(`people ${verb}: ${arg} can be given once`);
    }
    list.push(value);
    values.set(name, list);
  }
  return { positional, values, booleans };
}

const one = (args: Args, name: string): string | undefined => args.values.get(name)?.[0];
const many = (args: Args, name: string): readonly string[] => args.values.get(name) ?? [];

function noPositional(verb: string, args: Args): void {
  if (args.positional.length > 0) {
    throw new Error(`people ${verb}: unexpected argument "${args.positional[0]}"`);
  }
}

/** Exactly one positional: the profile or note the verb is about. */
function exactlyOne(verb: string, args: Args, what: string): string {
  if (args.positional.length === 0) throw new Error(`people ${verb}: name ${what}`);
  if (args.positional.length > 1) {
    throw new Error(`people ${verb}: unexpected argument "${args.positional[1]}"`);
  }
  return args.positional[0] as string;
}

function requireValue(verb: string, args: Args, name: string): string {
  const value = one(args, name);
  if (value === undefined) throw new Error(`people ${verb}: --${name} is required`);
  return value;
}

function choice<T extends string>(verb: string, flag: string, list: readonly T[], raw: string): T {
  const found = list.find((word) => word === raw);
  if (found === undefined) {
    throw new Error(`people ${verb}: --${flag} must be one of ${list.join(", ")} (got "${raw}")`);
  }
  return found;
}

function wholeNumber(verb: string, flag: string, raw: string, max: number): number {
  if (!/^[1-9][0-9]{0,5}$/.test(raw) || Number(raw) > max) {
    throw new Error(
      `people ${verb}: --${flag} takes a whole number from 1 to ${max} (got "${raw}")`,
    );
  }
  return Number(raw);
}

function purposesOf(verb: string, args: Args): PeoplePurpose[] | undefined {
  const given = many(args, "purpose");
  if (given.length === 0) return undefined;
  return given.map((p) => choice(verb, "purpose", PEOPLE_PURPOSES, p));
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

type Session = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hangarRoot: string;
  readonly now: () => number;
  readonly identity: LocalIdentity;
  readonly localActor: string;
  readonly isTTY: boolean;
  readonly stdinIsFile: boolean | undefined;
  readonly hideInput: () => (() => void) | undefined;
  readonly prompt: (text: string) => void;
  readonly line: () => Promise<string | undefined>;
  readonly vault: () => Vault | { readonly ok: false; readonly reason: string };
};

function stdinReader(): { read: () => Promise<string | undefined>; close: () => void } {
  let lines: AsyncIterator<string> | undefined;
  let close = (): void => undefined;
  return {
    read: async () => {
      if (lines === undefined) {
        const rl = createInterface({ input: process.stdin, terminal: false });
        close = () => rl.close();
        lines = rl[Symbol.asyncIterator]();
      }
      const next = await lines.next();
      return next.done === true ? undefined : next.value;
    },
    close: () => close(),
  };
}

/** Whether a descriptor is a regular file; `undefined` when it cannot be told. */
export function isRegularFileFd(fd: number): boolean | undefined {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return undefined;
  }
}

/** `stty -echo` on the controlling terminal, undone by the returned function or on Ctrl-C. */
function hideTypedInput(): (() => void) | undefined {
  if (process.platform === "win32") return undefined;
  const stty = (setting: string): boolean => {
    try {
      return spawnSync("stty", [setting], { stdio: ["inherit", "ignore", "ignore"] }).status === 0;
    } catch {
      return false;
    }
  };
  if (!stty("-echo")) return undefined;
  const onInterrupt = (): void => {
    stty("echo");
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  return () => {
    process.removeListener("SIGINT", onInterrupt);
    stty("echo");
  };
}

function sessionFor(opts: PeopleCommandOptions, line: () => Promise<string | undefined>): Session {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const identity = opts.identity ?? currentLocalIdentity();
  const hangarRoot = resolveHangarRoot(env);
  let vault: ReturnType<Session["vault"]> | undefined;
  return {
    env,
    hangarRoot,
    now,
    identity,
    localActor: localActorOf(identity),
    isTTY: opts.isTTY ?? process.stdin.isTTY === true,
    stdinIsFile: "stdinIsFile" in opts ? opts.stdinIsFile : isRegularFileFd(0),
    hideInput: opts.hideInput ?? hideTypedInput,
    prompt: opts.prompt ?? ((text) => void process.stderr.write(text)),
    line,
    vault: () => {
      if (vault !== undefined) return vault;
      // This verb never writes the registry: `list()` would persist missing-directory stamps.
      const readOnlyEnv = { ...env, CREWHAUS_NO_REGISTRY: "1" };
      let harnessDirs: string[] = [];
      try {
        const registry = opts.openRegistry
          ? opts.openRegistry(readOnlyEnv)
          : openHangarRegistry({ env: readOnlyEnv, now });
        harnessDirs = registry.list().map((entry) => entry.dir);
      } catch {
        // No registry is no harness to keep the vault out of.
      }
      vault = openVault({
        root: join(hangarRoot, "people"),
        secrets: opts.secrets ?? Bun.secrets,
        env,
        harnessDirs,
        now,
      });
      return vault;
    },
  };
}

/** A line typed or piped in, after a prompt when a person is typing. */
async function ask(session: Session, question: string): Promise<string | undefined> {
  if (session.isTTY) session.prompt(question);
  const answer = await session.line();
  return answer?.replace(/\r$/, "");
}

function receiptsFor(session: Session): ReceiptsPort {
  let control: ReturnType<typeof wireControl> | undefined;
  return (request, effect) => {
    control ??= wireControl(
      {
        hangarRoot: session.hangarRoot,
        identity: session.identity,
        now: session.now,
        probe: withOwnStartTime(createProcessOps()),
        supervisorFor: () => undefined,
        drainRequest: () => async () => undefined,
      },
      { mode: "direct" },
    );
    return control.commands.submit(request, effect);
  };
}

const NOT_SET_UP: PeopleCommandResult = {
  lines: ["Profiles aren't set up on this computer yet.", "Set them up: crewhaus people init"],
  exitCode: 0,
};

const OTHER_USER = "This Home belongs to another user on this computer.";

function lockedLines(reason: string): PeopleCommandResult {
  return {
    lines: [
      "Profiles are locked. This computer can't reach the profile key.",
      `  ${reason}`,
      "See where it is kept: crewhaus people keys",
    ],
    exitCode: 1,
  };
}

function answerLines(answer: Refused): PeopleCommandResult {
  if (answer.reason === "not-set-up") return { lines: NOT_SET_UP.lines, exitCode: 1 };
  if (answer.reason === "locked") return lockedLines(answer.detail ?? answer.message);
  return {
    lines: [answer.message, ...(answer.detail !== undefined ? [`  ${answer.detail}`] : [])],
    exitCode: 1,
  };
}

type Opened =
  | { readonly admin: PeopleAdmin; readonly principal: string; readonly vault: Vault }
  | { readonly done: PeopleCommandResult };

/** For a read: the vault and the admin, setting nothing up. */
async function forReading(session: Session): Promise<Opened> {
  const vault = session.vault();
  if (!vault.ok) return { done: { lines: [vault.reason], exitCode: 1 } };
  const status = await vault.status();
  if (status.state === "not-set-up") return { done: NOT_SET_UP };
  const read = loadAccessSnapshot(session.hangarRoot);
  if (read.state === "unreadable") {
    return { done: { lines: [`The access records cannot be read: ${read.reason}.`], exitCode: 1 } };
  }
  const principal =
    read.state === "present" ? localPrincipalOf(read.snapshot, session.localActor) : undefined;
  if (principal === undefined) return { done: { lines: [OTHER_USER], exitCode: 1 } };
  if (status.state === "locked") return { done: lockedLines(status.reason) };
  if (status.state === "unreadable") {
    return { done: { lines: [`The profiles can't be read: ${status.reason}`], exitCode: 1 } };
  }
  const admin = createPeopleAdmin({
    vault,
    receipts: receiptsFor(session),
    actor: principal,
    now: session.now,
  });
  return { admin, principal, vault };
}

/** For a change: a set-up vault, then this OS user's principal, set up if need be. */
async function forWriting(session: Session, requireVault = true): Promise<Opened> {
  const vault = session.vault();
  if (!vault.ok) return { done: { lines: [vault.reason], exitCode: 1 } };
  if (requireVault) {
    const status = await vault.status();
    if (status.state === "not-set-up") return { done: { lines: NOT_SET_UP.lines, exitCode: 1 } };
    if (status.state === "locked") return { done: lockedLines(status.reason) };
  }
  const setup = await ensureAccessSetUp(session.hangarRoot, {
    localActor: session.localActor,
    now: session.now,
    ...(session.identity.username !== "" ? { displayName: session.identity.username } : {}),
  });
  if (!setup.ok) return { done: { lines: [setup.reason], exitCode: 1 } };
  const principal = setup.result.localPrincipal;
  if (principal === undefined) return { done: { lines: [OTHER_USER], exitCode: 1 } };
  const admin = createPeopleAdmin({
    vault,
    receipts: receiptsFor(session),
    actor: principal,
    now: session.now,
  });
  return { admin, principal, vault };
}

/** Whether this principal may manage Home's settings, which the vault's own verbs need. */
function managesHome(session: Session, principal: string): boolean {
  const access = openAccess(session.hangarRoot, { now: session.now });
  return access.authorize(access.load(), { principal }, "home.settings.manage", { scope: "home" })
    .allow;
}

function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

const KIND_WORDS: Readonly<Record<PersonKind, string>> = {
  personal: "Personal",
  audience: "Group",
  synthetic: "Made-up persona",
};

function custodyWords(custody: VaultCustody, session: Session): string {
  switch (custody) {
    case "keychain":
      return "this computer's credential store";
    case "environment":
      return SPACE_KEY_ENV;
    case "file":
      return `a key file in ${join(session.hangarRoot, "people", "keys")}`;
  }
}

const day = (iso: string): string => iso.slice(0, 10);

function noteLine(note: StoredClaim): string {
  const when = note.situation !== undefined ? ` (when ${note.situation})` : "";
  return `  [${note.area}] ${note.value}${when}  ${note.id}`;
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

async function initVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("init", argv, CLI_FAMILY.sub.init.flags);
  noPositional("init", args);
  const raw = one(args, "custody");
  const given = raw === undefined ? undefined : choice("init", "custody", VAULT_CUSTODIES, raw);
  const daysRaw = one(args, "backup-days");
  const backupDays =
    daysRaw === undefined ? undefined : wholeNumber("init", "backup-days", daysRaw, 3650);
  const vault = session.vault();
  if (!vault.ok) return { lines: [vault.reason], exitCode: 1 };
  const status = await vault.status();
  let custody: VaultCustody;
  if (status.state === "ready" || status.state === "locked") {
    custody = given ?? status.custody;
  } else if (given !== undefined) {
    custody = given;
  } else if (await vault.probeKeychain()) {
    custody = "keychain";
  } else {
    return {
      lines: [
        "This computer's credential store can't be reached here, so choose where the profile key is kept:",
        "  crewhaus people init --custody keychain      this computer's credential store",
        `  crewhaus people init --custody environment   ${SPACE_KEY_ENV} (weaker)`,
        "  crewhaus people init --custody file          a key file beside the profiles (weaker)",
      ],
      exitCode: 1,
    };
  }
  if (status.state === "not-set-up") {
    if (custody === "keychain" && !(await vault.probeKeychain())) {
      return { lines: ["This computer's credential store can't be reached here."], exitCode: 1 };
    }
    if (custody === "environment" && !KEY_HEX_RE.test(session.env[SPACE_KEY_ENV]?.trim() ?? "")) {
      return {
        lines: [
          `${SPACE_KEY_ENV} is not 64 hex characters.`,
          "Set it (for example from `openssl rand -hex 32`), then run this again.",
        ],
        exitCode: 1,
      };
    }
  }
  const opened = await forWriting(session, false);
  if ("done" in opened) return opened.done;
  if (!managesHome(session, opened.principal)) {
    return { lines: ["Only this Home's owner can set up profiles."], exitCode: 1 };
  }
  const answer = await opened.admin.setup({
    custody,
    ...(backupDays !== undefined ? { backupDays } : {}),
  });
  if (!answer.ok) return answerLines(answer);
  const lines: string[] = [];
  if (answer.value.created) {
    lines.push(`Profiles are set up. Their key is kept in ${custodyWords(custody, session)}.`);
    if (custody !== "keychain") {
      lines.push(
        "Anything running as you on this computer can read that key; the credential store is safer.",
      );
    }
  } else if (backupDays !== undefined) {
    lines.push(`Backups are now taken to keep files for ${backupDays} days.`);
  } else {
    lines.push(
      `Profiles are already set up. Their key is kept in ${custodyWords(custody, session)}.`,
    );
  }
  if (answer.value.created && backupDays !== undefined) {
    lines.push(`Backups are taken to keep files for ${backupDays} days.`);
  }
  lines.push("Add one about you: crewhaus people add --kind personal");
  return { lines, exitCode: 0 };
}

async function keysVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("keys", argv, CLI_FAMILY.sub.keys.flags);
  noPositional("keys", args);
  if (!args.booleans.has("rotate")) {
    const vault = session.vault();
    if (!vault.ok) return { lines: [vault.reason], exitCode: 1 };
    const status = await vault.status();
    if (args.booleans.has("json")) {
      const view =
        status.state === "ready"
          ? {
              state: "ready",
              custody: status.custody,
              kekVersion: status.kekVersion,
              ...(status.backupDays !== undefined ? { backupDays: status.backupDays } : {}),
            }
          : status.state === "locked"
            ? {
                state: "locked",
                custody: status.custody,
                kekVersion: status.kekVersion,
                reason: status.reason,
              }
            : status.state === "unreadable"
              ? { state: "locked", reason: status.reason }
              : { state: "not-set-up" };
      return { lines: jsonLines(view), exitCode: 0 };
    }
    if (status.state === "not-set-up") return NOT_SET_UP;
    if (status.state === "unreadable") {
      return { lines: [`The profiles can't be read: ${status.reason}`], exitCode: 1 };
    }
    if (status.state === "locked") {
      return {
        lines: [
          "Profiles are locked. This computer can't reach the profile key.",
          `  ${status.reason}`,
          `The key is kept in ${custodyWords(status.custody, session)}.`,
        ],
        exitCode: 1,
      };
    }
    return {
      lines: [
        `The profile key is kept in ${custodyWords(status.custody, session)} (version ${status.kekVersion}).`,
        status.backupDays !== undefined
          ? `Backups keep files for ${status.backupDays} days.`
          : "How long your backups keep files isn't set: crewhaus people init --backup-days <n>",
        status.custody === "environment"
          ? `Replace the key: ${SAVED_KEY_ROTATION}`
          : "Replace the key: crewhaus people keys --rotate",
      ],
      exitCode: 0,
    };
  }
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  if (!managesHome(session, opened.principal)) {
    return { lines: ["Only this Home's owner can rotate the profile key."], exitCode: 1 };
  }
  const status = await opened.vault.status();
  let newKey: string | undefined;
  if (status.state === "ready" && status.custody === "environment") {
    const given = await keptNewKey(session);
    if ("refused" in given) return { lines: given.refused, exitCode: 1 };
    newKey = given.key;
  }
  const answer = await opened.admin.rotateKeys(newKey);
  if (!answer.ok) return answerLines(answer);
  const lines = [
    answer.value.resumed
      ? `Finished a key rotation that was interrupted (now version ${answer.value.kekVersion}).`
      : `Replaced the profile key (now version ${answer.value.kekVersion}).`,
  ];
  if (answer.value.oldKey === "kept") {
    lines.push(
      `Set ${SPACE_KEY_ENV} to the new key before your next \`crewhaus people\` command. The old key no longer opens your profiles.`,
    );
  }
  return { lines, exitCode: 0 };
}

/** How to replace a key kept in an environment variable without losing it. */
const SAVE_KEY_FIRST: readonly string[] = [
  "Save the new key to a file first, then read it in from that file:",
  `  ${SAVED_KEY_ROTATION}`,
  `Then set ${SPACE_KEY_ENV} to the key in new.key.`,
];

/**
 * The new key under environment custody, only from where the person keeps it: a file
 * redirected in, or typed twice with nothing shown. A key piped straight from a generator
 * would be stored nowhere once the rotation re-wraps every profile under it.
 */
async function keptNewKey(
  session: Session,
): Promise<{ readonly key: string } | { readonly refused: readonly string[] }> {
  const nothing = "Nothing was rotated: under environment custody the new key comes from you.";
  if (session.isTTY) {
    const restore = session.hideInput();
    if (restore === undefined) {
      return { refused: [`${nothing} This terminal can't hide a typed key.`, ...SAVE_KEY_FIRST] };
    }
    let first: string | undefined;
    let second: string | undefined;
    try {
      first = (await ask(session, "New key (64 hex characters, not shown): "))?.trim();
      session.prompt("\n");
      if (first !== undefined && first !== "") {
        second = (await ask(session, "The same key again: "))?.trim();
        session.prompt("\n");
      }
    } finally {
      restore();
    }
    if (first === undefined || first === "") return { refused: [nothing, ...SAVE_KEY_FIRST] };
    if (second !== first) {
      return { refused: ["Nothing was rotated: the two keys you typed don't match."] };
    }
    return { key: first };
  }
  if (session.stdinIsFile !== true) {
    return {
      refused: [`${nothing} It is read from a file you saved, never a pipe.`, ...SAVE_KEY_FIRST],
    };
  }
  const key = (await session.line())?.trim();
  if (key === undefined || key === "") {
    return { refused: [`${nothing} The file was empty.`, ...SAVE_KEY_FIRST] };
  }
  return { key };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

async function listVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("list", argv, CLI_FAMILY.sub.list.flags);
  noPositional("list", args);
  const opened = await forReading(session);
  if ("done" in opened) return opened.done;
  const answer = await opened.admin.listPersons();
  if (!answer.ok) return answerLines(answer);
  if (args.booleans.has("json")) return { lines: jsonLines({ items: answer.value }), exitCode: 0 };
  if (answer.value.length === 0) {
    return {
      lines: ["No profiles yet.", "Start with one about you: crewhaus people add --kind personal"],
      exitCode: 0,
    };
  }
  const ROLE: Readonly<Record<string, string>> = {
    owner: "",
    custodian: " · you look after it",
    viewer: " · shared with you",
  };
  return {
    lines: answer.value.map((row) =>
      row.state === "erasing"
        ? `(being erased) · ${row.person}`
        : `${row.label} · ${KIND_WORDS[row.kind]}${ROLE[row.role] ?? ""} · ${row.person}`,
    ),
    exitCode: 0,
  };
}

async function addVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("add", argv, CLI_FAMILY.sub.add.flags);
  noPositional("add", args);
  const kind = choice(
    "add",
    "kind",
    ["personal", "audience", "synthetic"] as const,
    requireValue("add", args, "kind"),
  );
  const describesRaw = one(args, "describes");
  const describes =
    describesRaw === undefined
      ? undefined
      : choice("add", "describes", ["self", "someone-else"] as const, describesRaw);
  const basis = one(args, "basis");
  const variationRaw = one(args, "variation");
  const variation =
    variationRaw === undefined
      ? undefined
      : choice("add", "variation", ["uniform", "mixed", "unknown"] as const, variationRaw);
  const sizeRaw = one(args, "size");
  const size = sizeRaw === undefined ? undefined : wholeNumber("add", "size", sizeRaw, 999_999);
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  const label = (await ask(session, "Name: "))?.trim();
  if (label === undefined || label === "") {
    throw new Error("people add: a profile needs a name, typed or piped in");
  }
  let who: string | undefined;
  if (kind === "audience") {
    who = (await ask(session, "Who is in this group, and how do you know? "))?.trim();
    if (who === undefined || who === "") {
      throw new Error(
        "people add: a group profile says who is in the group, on the line after its name",
      );
    }
  }
  const answer = await opened.admin.createPerson({
    kind,
    label,
    ...(describes !== undefined ? { describes } : {}),
    ...(basis !== undefined ? { basis: basis as never } : {}),
    ...(who !== undefined ? { who } : {}),
    ...(variation !== undefined ? { variation } : {}),
    ...(size !== undefined ? { size } : {}),
  });
  if (!answer.ok) return answerLines(answer);
  const psn = answer.value.person;
  const lines = [`Added ${label} (${KIND_WORDS[kind]}): ${psn}`];
  if (kind === "synthetic")
    lines.push("This persona is made up. It's labelled that way everywhere it's used.");
  if (kind === "audience") {
    lines.push("Group notes describe a group. They're never treated as facts about one person.");
  }
  lines.push(`Add a note: crewhaus people note ${psn} --area communication`);
  return { lines, exitCode: 0 };
}

async function showVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("show", argv, CLI_FAMILY.sub.show.flags);
  const psn = exactlyOne("show", args, "<psn_…>");
  const opened = await forReading(session);
  if ("done" in opened) return opened.done;
  const person = await opened.admin.getPerson(psn);
  if (!person.ok) return answerLines(person);
  const notes = await opened.admin.listClaims(psn);
  if (!notes.ok) return answerLines(notes);
  if (args.booleans.has("json")) {
    return { lines: jsonLines({ person: person.value, notes: notes.value }), exitCode: 0 };
  }
  const view = person.value;
  const others =
    view.viewers.length + (view.custodian !== undefined && view.custodian !== view.owner ? 1 : 0);
  const stated = notes.value.filter((n) => n.state === "active" && n.acquisition === "stated");
  const inferred = notes.value.filter((n) => n.state === "active" && n.acquisition !== "stated");
  const review = notes.value.filter((n) => n.state === "proposed");
  const rejected = notes.value.filter((n) => n.state === "rejected").length;
  const lines = [
    `${view.label} · ${KIND_WORDS[view.kind]} · ${view.person}`,
    others === 0
      ? "Only you can open this profile."
      : `You and ${others === 1 ? "1 other person" : `${others} others`} can open this profile. Workspace owners can't.`,
    ...(view.offLimits.length > 0 ? [`Off-limits: ${view.offLimits.join(", ")}`] : []),
    "",
    "What this profile says",
    ...(stated.length > 0 ? stated.map(noteLine) : ["  Nothing yet."]),
    ...(inferred.length > 0 ? ["", "What is inferred", ...inferred.map(noteLine)] : []),
    "",
    "What needs review",
    ...(review.length > 0
      ? [...review.map(noteLine), "  Keep one: crewhaus people review <pcl_…> --as keep"]
      : ["  Nothing to review."]),
    ...(rejected > 0
      ? [`  ${rejected === 1 ? "1 rejected note stays" : `${rejected} rejected notes stay`} out.`]
      : []),
    "",
    "Where it is used",
    "  No harness uses this profile yet.",
  ];
  return { lines, exitCode: 0 };
}

async function setVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("set", argv, CLI_FAMILY.sub.set.flags);
  const psn = exactlyOne("set", args, "<psn_…>");
  const offLimits = many(args, "off-limits");
  const allow = many(args, "allow");
  const viewers = many(args, "viewer");
  const removeViewers = many(args, "remove-viewer");
  const rename = args.booleans.has("rename");
  if (offLimits.length + allow.length + viewers.length + removeViewers.length === 0 && !rename) {
    throw new Error(
      "people set: nothing to change (give --off-limits, --allow, --viewer, --remove-viewer or --rename)",
    );
  }
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  const current = await opened.admin.getPerson(psn);
  if (!current.ok) return answerLines(current);
  let label: string | undefined;
  if (rename) {
    label = (await ask(session, "New name: "))?.trim();
    if (label === undefined || label === "")
      throw new Error("people set: --rename needs a new name, typed or piped in");
  }
  const answer = await opened.admin.updatePerson(
    psn,
    {
      ...(label !== undefined ? { label } : {}),
      ...(offLimits.length > 0 ? { offLimits } : {}),
      ...(allow.length > 0 ? { allow } : {}),
      ...(viewers.length > 0 ? { viewers } : {}),
      ...(removeViewers.length > 0 ? { removeViewers } : {}),
    },
    current.value.rev,
  );
  if (!answer.ok) return answerLines(answer);
  return { lines: [`Updated ${label ?? current.value.label}.`], exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

async function noteVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("note", argv, CLI_FAMILY.sub.note.flags);
  const psn = exactlyOne("note", args, "<psn_…>");
  const area = requireValue("note", args, "area");
  const purposes = purposesOf("note", args);
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  const value = (await ask(session, "Note: "))?.trim();
  if (value === undefined || value === "") {
    throw new Error("people note: a note's words are typed or piped in, never given as a flag");
  }
  const situation = (await ask(session, "When does it apply? (Enter to skip) "))?.trim();
  const type = one(args, "type");
  const sensitivity = one(args, "sensitivity");
  const confidence = one(args, "confidence");
  const reviewBy = one(args, "review-by");
  const answer = await opened.admin.addClaim(psn, {
    area,
    value,
    ...(situation !== undefined && situation !== "" ? { situation } : {}),
    ...(type !== undefined ? { type: type as never } : {}),
    ...(purposes !== undefined ? { purposes } : {}),
    ...(sensitivity !== undefined ? { sensitivity: sensitivity as never } : {}),
    ...(confidence !== undefined ? { confidence: confidence as never } : {}),
    ...(reviewBy !== undefined ? { reviewBy } : {}),
  });
  if (!answer.ok) return answerLines(answer);
  const lines = [`Added a note (${answer.value.claim}).`];
  if (answer.value.state === "proposed") {
    lines.push(
      "It's sensitive, so it waits in review until you keep it:",
      `  crewhaus people review ${answer.value.claim} --as keep`,
    );
  }
  return { lines, exitCode: 0 };
}

/** The note `pcl` among the actor's profiles, as it stands. */
async function findNote(admin: PeopleAdmin, pcl: string): Promise<StoredClaim | undefined> {
  const persons = await admin.listPersons();
  if (!persons.ok) return undefined;
  for (const row of persons.value) {
    const notes = await admin.listClaims(row.person);
    const found = notes.ok ? notes.value.find((note) => note.id === pcl) : undefined;
    if (found !== undefined) return found;
  }
  return undefined;
}

async function editVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("edit", argv, CLI_FAMILY.sub.edit.flags);
  const pcl = exactlyOne("edit", args, "<pcl_…>");
  const expectRaw = one(args, "expect");
  const expected =
    expectRaw === undefined ? undefined : wholeNumber("edit", "expect", expectRaw, 999_999);
  if (!isId("pcl", pcl)) throw new Error(`people edit: "${pcl}" is not a note id (pcl_…)`);
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  const current = await findNote(opened.admin, pcl);
  // Asked before any typing: a note this person can't see is the same answer as no note.
  if (current === undefined) return { lines: ["No profile or note with that id."], exitCode: 1 };
  const value = (await ask(session, "New text: "))?.trim();
  if (value === undefined || value === "") {
    throw new Error("people edit: the new words are typed or piped in, never given as a flag");
  }
  const situation = (await ask(session, "When does it apply? (Enter keeps it) "))?.trim();
  const keep = situation === undefined || situation === "" ? current.situation : situation;
  const answer = await opened.admin.reviseClaim(
    pcl,
    { value, ...(keep !== undefined ? { situation: keep } : {}) },
    expected ?? current.rev,
  );
  if (!answer.ok) {
    if (answer.reason === "stale_claim_revision") {
      const now = answer.current as StoredClaim | undefined;
      return {
        lines: [
          "This note changed since you opened it. It now says:",
          ...(now !== undefined ? [noteLine(now), `Edit it again with --expect ${now.rev}.`] : []),
        ],
        exitCode: 1,
      };
    }
    return answerLines(answer);
  }
  return { lines: [`Updated the note (revision ${answer.value.rev}).`], exitCode: 0 };
}

const VERDICT_DONE: Readonly<Record<string, string>> = {
  keep: "Kept. The note now counts.",
  reject: "Rejected. It stays out until you reopen it.",
  reopen: "Reopened. It waits in review.",
  narrow: "Narrowed.",
  merge: "Merged.",
};

async function reviewVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("review", argv, CLI_FAMILY.sub.review.flags);
  const id = exactlyOne("review", args, "a profile (psn_…) or a note (pcl_…)");
  if (isId("psn", id)) {
    if (args.values.size > 0) throw new Error("people review: a profile's tray takes no flags");
    const opened = await forReading(session);
    if ("done" in opened) return opened.done;
    const tray = await opened.admin.reviewList(id);
    if (!tray.ok) return answerLines(tray);
    if (tray.value.length === 0) return { lines: ["Nothing to review."], exitCode: 0 };
    return {
      lines: [
        ...tray.value.map(noteLine),
        "Keep one: crewhaus people review <pcl_…> --as keep (or reject, narrow, merge)",
      ],
      exitCode: 0,
    };
  }
  if (!isId("pcl", id)) {
    throw new Error(`people review: "${id}" is neither a profile (psn_…) nor a note (pcl_…)`);
  }
  const verdictRaw = one(args, "as");
  if (verdictRaw === undefined) {
    throw new Error(
      "people review: say what to do with --as keep, reject, reopen, narrow or merge",
    );
  }
  const verdict = choice(
    "review",
    "as",
    ["keep", "reject", "reopen", "narrow", "merge"] as const,
    verdictRaw,
  );
  const purposes = purposesOf("review", args);
  const into = one(args, "into");
  if (verdict === "narrow" && purposes === undefined) {
    throw new Error("people review: --as narrow needs the purposes to keep, with --purpose");
  }
  if (verdict === "merge" && into === undefined) {
    throw new Error("people review: --as merge needs --into <pcl_…>");
  }
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  const answer = await opened.admin.reviewClaim(id, {
    verdict,
    ...(purposes !== undefined ? { purposes } : {}),
    ...(into !== undefined ? { into } : {}),
  });
  if (!answer.ok) return answerLines(answer);
  return { lines: [VERDICT_DONE[verdict] ?? "Done."], exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Export and activity
// ---------------------------------------------------------------------------

async function exportVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("export", argv, CLI_FAMILY.sub.export.flags);
  const psn = exactlyOne("export", args, "<psn_…>");
  const out = one(args, "out");
  const summary = args.booleans.has("summary");
  if (summary && out === undefined) {
    throw new Error(
      "people export: --summary writes a file beside --out <file>, so it needs --out",
    );
  }
  const options = {
    ...(many(args, "area").length > 0 ? { areas: many(args, "area") } : {}),
    ...(purposesOf("export", args) !== undefined ? { purposes: purposesOf("export", args) } : {}),
    ...(args.booleans.has("include-sensitive") ? { includeSensitive: true } : {}),
    ...(args.booleans.has("no-rejected") ? { includeRejected: false } : {}),
    ...(summary ? { summary: true } : {}),
  };
  if (args.booleans.has("dry-run")) {
    const opened = await forReading(session);
    if ("done" in opened) return opened.done;
    const answer = await opened.admin.previewExport(psn, options);
    if (!answer.ok) return answerLines(answer);
    const { counts, sha256 } = answer.value.preview;
    return {
      lines: [
        `This file will contain ${counts.notes === 1 ? "1 note" : `${counts.notes} notes`}.`,
        ...(counts.rejected > 0
          ? [
              `It also lists ${counts.rejected} rejected, so they stay rejected if you import it later.`,
            ]
          : []),
        ...(counts.leftOut > 0
          ? [`${counts.leftOut} sensitive left out (add --include-sensitive).`]
          : []),
        ...(counts.masked > 0
          ? [`${counts.masked} hid something that looks like a password or key.`]
          : []),
        `Fingerprint (sha256): ${sha256}`,
        `Export it: crewhaus people export ${psn} --out <file>`,
      ],
      exitCode: 0,
    };
  }
  const opened = await forWriting(session);
  if ("done" in opened) return opened.done;
  session.prompt(
    "A downloaded file can't be recalled. To share with a harness you can switch off later, let the harness use the profile instead.\n",
  );
  const answer = await opened.admin.writeExport(psn, options, {
    ...(out !== undefined ? { path: out } : {}),
    ...(args.booleans.has("force") ? { force: true } : {}),
  });
  if (!answer.ok) return answerLines(answer);
  if (out === undefined) return { lines: [answer.value.text.replace(/\n$/, "")], exitCode: 0 };
  const { counts, sha256 } = answer.value.preview;
  return {
    lines: [
      `Wrote ${counts.notes === 1 ? "1 note" : `${counts.notes} notes`} to ${out}.`,
      ...(summary ? [`A readable summary is beside it: ${out}.txt`] : []),
      `Fingerprint (sha256): ${sha256}`,
    ],
    exitCode: 0,
  };
}

const EVENT_WORDS: Readonly<Record<string, (counts: Readonly<Record<string, number>>) => string>> =
  {
    "person.created": () => "profile created",
    "person.updated": () => "profile changed",
    "claim.created": () => "note added",
    "claim.revised": () => "note edited",
    "claim.reviewed": () => "note reviewed",
    "export.created": (c) => `exported ${c["notes"] === 1 ? "1 note" : `${c["notes"] ?? 0} notes`}`,
  };

async function activityVerb(
  session: Session,
  argv: readonly string[],
): Promise<PeopleCommandResult> {
  const args = parseArgs("activity", argv, CLI_FAMILY.sub.activity.flags);
  const psn = exactlyOne("activity", args, "<psn_…>");
  const limitRaw = one(args, "limit");
  const limit = limitRaw === undefined ? 20 : wholeNumber("activity", "limit", limitRaw, 500);
  const opened = await forReading(session);
  if ("done" in opened) return opened.done;
  const answer = await opened.admin.activity(psn, { limit });
  if (!answer.ok) return answerLines(answer);
  if (args.booleans.has("json")) return { lines: jsonLines(answer.value), exitCode: 0 };
  if (answer.value.items.length === 0) return { lines: ["No activity yet."], exitCode: 0 };
  const who = (row: PersonActivityRow): string =>
    row.actor === opened.principal ? "you" : row.actor;
  return {
    lines: [
      ...answer.value.items.map(
        (row) =>
          `${row.at.slice(0, 16).replace("T", " ")}  ${(EVENT_WORDS[row.event] ?? (() => row.event))(row.counts)}, by ${who(row)}`,
      ),
      ...(answer.value.more ? [`Older activity: crewhaus people activity ${psn} --limit 500`] : []),
    ],
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

function residueLine(residue: ErasureResidue): string {
  switch (residue.code) {
    case "downloaded-export":
      return `  a file you downloaded (${day(residue.at ?? "")})`;
    case "backups":
      return `  backups made before today, until ${residue.until ?? "they expire"}`;
    case "backups-unknown":
      return "  backups made before today. We don't know how long your backups keep files: crewhaus people init --backup-days <n>";
    case "space-key-not-rotated":
      return `  the profile key in ${SPACE_KEY_ENV}, until you replace it: ${SAVED_KEY_ROTATION}`;
  }
}

async function eraseVerb(session: Session, argv: readonly string[]): Promise<PeopleCommandResult> {
  const args = parseArgs("erase", argv, CLI_FAMILY.sub.erase.flags);
  const psn = exactlyOne("erase", args, "<psn_…>");
  const dryRun = args.booleans.has("dry-run");
  const opened = dryRun ? await forReading(session) : await forWriting(session);
  if ("done" in opened) return opened.done;
  const plan = await opened.admin.planErasure(psn);
  if (!plan.ok) return answerLines(plan);
  const { counts, residue } = plan.value;
  const planLines = [
    `This removes the profile, ${counts.notes === 1 ? "1 note" : `${counts.notes} notes`} and their history, and its record of rejected notes, exports and activity.`,
    ...(residue.length > 0
      ? ["These stay, and CrewHaus can't remove them:", ...residue.map(residueLine)]
      : []),
  ];
  if (dryRun) {
    return {
      lines: [...planLines, `To erase it: crewhaus people erase ${psn}`],
      exitCode: 0,
    };
  }
  let confirm = "";
  if (plan.value.resuming) {
    session.prompt("This profile's erasure was interrupted. Finishing it.\n");
  } else {
    session.prompt(`${planLines.join("\n")}\n`);
    confirm = (await ask(session, "Type the profile's name to confirm: "))?.trim() ?? "";
    if (confirm === "") return { lines: ["Nothing was erased."], exitCode: 1 };
  }
  const answer = await opened.admin.runErasure(psn, { nonce: plan.value.nonce, confirm });
  if (!answer.ok) return answerLines(answer);
  return {
    lines: [
      "Erased. A record that an erasure happened is kept; it contains nothing from the profile.",
    ],
    exitCode: 0,
  };
}

/**
 * Run one `crewhaus people` verb. Bare `people`, `--help` and `-h` print usage, before
 * anything is read or opened.
 */
export async function runPeopleCommand(
  argv: readonly string[],
  opts: PeopleCommandOptions = {},
): Promise<PeopleCommandResult> {
  const verb = argv[0] ?? "";
  if (verb === "" || verb === "--help" || verb === "-h" || verb === "help") {
    return { lines: PEOPLE_USAGE_LINES, exitCode: 0 };
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { lines: PEOPLE_USAGE_LINES, exitCode: 0 };
  }
  if (!Object.hasOwn(CLI_FAMILY.sub, verb)) {
    throw new Error(
      `people: unknown verb "${verb}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const reader = opts.stdin === undefined ? stdinReader() : undefined;
  const session = sessionFor(opts, opts.stdin ?? (reader as ReturnType<typeof stdinReader>).read);
  try {
    switch (verb) {
      case "init":
        return await initVerb(session, rest);
      case "keys":
        return await keysVerb(session, rest);
      case "list":
        return await listVerb(session, rest);
      case "add":
        return await addVerb(session, rest);
      case "show":
        return await showVerb(session, rest);
      case "set":
        return await setVerb(session, rest);
      case "note":
        return await noteVerb(session, rest);
      case "edit":
        return await editVerb(session, rest);
      case "review":
        return await reviewVerb(session, rest);
      case "export":
        return await exportVerb(session, rest);
      case "activity":
        return await activityVerb(session, rest);
      default:
        return await eraseVerb(session, rest);
    }
  } finally {
    reader?.close();
  }
}
