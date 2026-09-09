/**
 * Derive everything setup needs from the harness's OWN `crewhaus.yaml`.
 *
 * This is the module that keeps the command generic. Nothing here assumes a
 * naming convention: the Slack credential variable NAMES come from the spec's
 * own `$VAR` refs (`channel-adapter-slack` never reads a credential from the
 * environment — the daemon passes them in as constructor config, so the names
 * are entirely the author's choice), the wiki space slug comes from
 * `thredz.space`, and the public hostname is derived from the spec `name`
 * unless the operator names one. A fleet that prefixes its variables per role
 * and a lone harness using the bare defaults both work, because in both cases
 * the spec already says which variables it wants.
 *
 * Reading is deliberately tolerant — plain YAML, not `parseSpec`. A spec
 * mid-authoring, or one that fails a strict rule unrelated to services, must
 * still be provisionable; that is the same judgement `@crewhaus/preflight`
 * makes about raw specs, and the reason `lowerSecretString` takes `unknown`.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  type SecretRef,
  isMalformedEnvRef,
  lowerSecretString,
  malformedEnvRefMessage,
} from "@crewhaus/preflight";
import { parse as parseYaml } from "yaml";
import { ServiceSetupError } from "./types";

/**
 * The events listener port a compiled channel daemon binds.
 *
 * It is `process.env.PORT` with this default and has NO spec field — the
 * spec's `gateway.port` is a SEPARATE control-UI listener compiled in as a
 * literal. Getting these two confused points the tunnel at the status page
 * instead of the webhook route, which fails in the most confusing possible
 * way (the hostname serves a page, and Slack still times out), so setup
 * reports both and tunnels the events port.
 */
export const DEFAULT_EVENTS_PORT = 3000;

/** The gateway route shape: `/<adapterId>/events` and `/<adapterId>/actions`. */
export const SLACK_EVENTS_PATH = "/slack/events";
export const SLACK_ACTIONS_PATH = "/slack/actions";

/** Where a resolved credential ultimately lands. */
export type CredentialSlot = {
  /** The spec field this came from, for messages: `channels.slack.botToken`. */
  readonly label: string;
  /** The lowered ref — an env NAME, or a literal already inlined in the spec. */
  readonly ref: SecretRef;
};

/** The Slack half of a target, present only when the spec configures Slack. */
export type SlackTarget = {
  readonly botToken: CredentialSlot;
  readonly signingSecret: CredentialSlot;
  /** Whether the spec opts into 👍/👎 reaction ratings — it adds a scope+event. */
  readonly channelReactions: boolean;
};

/** The Thredz half, present only when the spec carries a `thredz:` block. */
export type ThredzTarget = {
  readonly apiKey: CredentialSlot;
  /**
   * The space slug the spec asks for, if any. `thredz.space` is compiled in
   * as a LITERAL (it becomes the MCP child's `THREDZ_DEFAULT_SPACE`), so when
   * setup creates a space it must write the slug back into the YAML — an env
   * ref would not survive lowering.
   */
  readonly space: string | undefined;
  /** `private` (the spec default) or `shared` — informs the space type. */
  readonly visibility: "private" | "shared";
};

/**
 * The AgentMail half of a target.
 *
 * AgentMail has NO first-class spec block, unlike `channels.slack` and
 * `thredz:`. A harness reaches it through an MCP stdio child, and what the
 * spec actually declares is the child's env: an AgentMail key and an inbox
 * id, both as `$VAR` refs under `mcp_servers.<name>.env`. So this is the one
 * target derived from a NAME heuristic rather than a structural field — see
 * {@link readAgentMailTarget} for the exact rule and why an override exists.
 */
export type AgentMailTarget = {
  /** The MCP server whose env declared it, named in messages. */
  readonly server: string;
  /** Where the inbox id goes — the spec's own ref, e.g. `$SECRETARY_INBOX_ID`. */
  readonly inboxId: CredentialSlot;
  /** The AgentMail key ref the spec declares, when it declares one. */
  readonly apiKey: CredentialSlot | undefined;
  /**
   * False when the harness has no LIVE ref to the variable setup writes —
   * either the mail tier is still commented out, or an override named a
   * different variable than the spec declares. Either way the operator has
   * an edit left to make before the daemon reads what setup wrote.
   */
  readonly declared: boolean;
  /**
   * The inbox variable the SPEC declares, when it declares one — which may
   * differ from the one setup writes if an override was given. Present so a
   * caller can say *which* mismatch it is rather than guessing.
   */
  readonly specInboxVar: string | undefined;
  /**
   * True when the match rested on an `*_INBOX_ID` name alone, with no
   * AgentMail credential in the same env block. The identification is a
   * guess at that point — another mail provider's MCP child could carry the
   * same variable name — so callers surface it rather than acting silently.
   */
  readonly matchedByNameOnly: boolean;
};

/** Everything setup derives from one harness directory. */
export type SetupTarget = {
  /** Absolute path to the spec file. */
  readonly specPath: string;
  /** The harness directory — where `.env` lives. */
  readonly harnessDir: string;
  /** `spec.name`, or the directory name when the spec has none. */
  readonly name: string;
  /** `spec.target` verbatim, for the shape-appropriateness check. */
  readonly shape: string | undefined;
  /** The port the Slack events listener binds (PORT env, default 3000). */
  readonly eventsPort: number;
  /** The control-UI port, when the spec declares one. Never tunnelled. */
  readonly gatewayPort: number | undefined;
  readonly slack: SlackTarget | undefined;
  readonly thredz: ThredzTarget | undefined;
  readonly agentmail: AgentMailTarget | undefined;
};

/** Options that override what the spec cannot say. */
export type ReadTargetOptions = {
  /**
   * The events port. The spec has no field for it, so the operator supplies
   * it (or setup takes the daemon's own default). Passing the value the
   * harness's launcher exports as `PORT` is the whole contract.
   */
  readonly eventsPort?: number;
  /**
   * The env variable the inbox id belongs in, when the spec does not say.
   *
   * A harness whose mail tier is not live yet has those refs COMMENTED OUT —
   * the crew ships them that way on purpose, since a `$VAR` ref under
   * `mcp_servers.*.env` is a hard boot gate and an empty value fails the
   * daemon. A comment is invisible to any parser, so the operator names the
   * variable instead of the tool guessing it.
   */
  readonly inboxVar?: string;
};

/**
 * Read a harness's spec into a {@link SetupTarget}.
 *
 * Throws only on the two faults that make provisioning meaningless: an
 * unreadable/unparseable spec, and a credential ref that is `$`-shaped but
 * malformed (`${SLACK_BOT_TOKEN}`, `$slack_token`) — those never lower to an
 * env ref, so writing a variable of that name would silently not be read.
 */
export function readSetupTarget(specPath: string, opts: ReadTargetOptions = {}): SetupTarget {
  const absolute = resolve(specPath);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    throw new ServiceSetupError("harness", `cannot read ${specPath}`, {
      fix: "run this from the harness directory, or pass the path to its crewhaus.yaml",
    });
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ServiceSetupError("harness", `${basename(absolute)} is not valid YAML: ${reason}`, {
      fix: "fix the YAML, then re-run — `crewhaus lint` reports spec errors in detail",
    });
  }

  const spec = asRecord(doc);
  const harnessDir = dirname(absolute);
  const name = readString(spec, "name") ?? basename(harnessDir);

  return {
    specPath: absolute,
    harnessDir,
    name,
    shape: readString(spec, "target"),
    eventsPort: opts.eventsPort ?? DEFAULT_EVENTS_PORT,
    gatewayPort: readPort(asRecord(spec["gateway"])["port"]),
    slack: readSlackTarget(spec),
    thredz: readThredzTarget(spec),
    agentmail: readAgentMailTarget(spec, opts.inboxVar),
  };
}

/** The Slack block, or undefined when the spec configures no Slack channel. */
function readSlackTarget(spec: Readonly<Record<string, unknown>>): SlackTarget | undefined {
  const slack = asRecord(asRecord(spec["channels"])["slack"]);
  if (Object.keys(slack).length === 0) return undefined;
  return {
    botToken: credentialSlot("channels.slack.botToken", slack["botToken"]),
    signingSecret: credentialSlot("channels.slack.signingSecret", slack["signingSecret"]),
    channelReactions: asRecord(spec["feedback"])["channelReactions"] === true,
  };
}

/**
 * The Thredz block, normalising the three spec forms: `thredz: true` (the
 * `$THREDZ_API_KEY` default), `thredz: $VAR` (the one-argument shorthand),
 * and the strict object.
 */
function readThredzTarget(spec: Readonly<Record<string, unknown>>): ThredzTarget | undefined {
  const raw = spec["thredz"];
  if (raw === undefined || raw === false) return undefined;

  if (raw === true) {
    return {
      apiKey: { label: "thredz.api_key", ref: { kind: "env", name: "THREDZ_API_KEY" } },
      space: undefined,
      visibility: "private",
    };
  }
  if (typeof raw === "string") {
    return {
      apiKey: credentialSlot("thredz", raw),
      space: undefined,
      visibility: "private",
    };
  }

  const block = asRecord(raw);
  const visibility = block["visibility"] === "shared" ? "shared" : "private";
  return {
    apiKey: credentialSlot("thredz.api_key", block["api_key"]),
    space: readString(block, "space"),
    visibility,
  };
}

/** An env key naming an inbox id: `INBOX_ID` or `<ROLE>_INBOX_ID`. */
const INBOX_ID_KEY_RE = /(?:^|_)INBOX_ID$/;

/**
 * An env key naming an AgentMail credential — `AGENTMAIL` anywhere, so a
 * fleet-prefixed `SECRETARY_AGENTMAIL_KEY` matches as readily as the bare
 * `AGENTMAIL_API_KEY`. An earlier anchored form required the prefix and so
 * missed exactly the per-role shape a fleet is most likely to use.
 */
const AGENTMAIL_KEY_RE = /(?:^|_)AGENTMAIL_[A-Z0-9_]*KEY$/;

/**
 * Find the AgentMail declaration, or undefined when the spec makes none.
 *
 * THE RULE: walk every `mcp_servers.<name>.env` block and take the first that
 * declares an inbox-id key, or an AgentMail key alongside one. Both are
 * matched by NAME, which is a compromise this file otherwise avoids — the
 * Slack and Thredz targets read structural fields, so nothing about their
 * naming has to be guessed. AgentMail has no such field to read: the spec's
 * only statement about it is which variables an MCP child receives.
 *
 * `override` (from `--inbox-var`) wins outright and is the answer to the
 * case the heuristic cannot reach. A harness whose mail tier is still in
 * dry-run keeps these refs commented out — deliberately, because a declared
 * ref is a hard boot gate and an unset one stops the daemon — and a comment
 * is invisible to a parser. Rather than pattern-match YAML comments, which
 * would make setup's behaviour depend on formatting, the operator names the
 * variable and setup writes it.
 */
function readAgentMailTarget(
  spec: Readonly<Record<string, unknown>>,
  override: string | undefined,
): AgentMailTarget | undefined {
  const servers = asRecord(spec["mcp_servers"]);

  for (const [server, config] of Object.entries(servers)) {
    const env = asRecord(asRecord(config)["env"]);
    const keys = Object.keys(env);
    const inboxKey = keys.find((k) => INBOX_ID_KEY_RE.test(k));
    const apiKeyKey = keys.find((k) => AGENTMAIL_KEY_RE.test(k));

    if (inboxKey === undefined && apiKeyKey === undefined) continue;

    // An AgentMail key with no inbox id is a half-declaration: the runtime
    // can authenticate and has nothing to send AS. Report it against the
    // override when given, so the message names a variable to fill.
    const inboxVar = override ?? inboxKey;
    if (inboxVar === undefined) continue;

    // BOTH halves of the slot follow the override. An earlier version let the
    // label take the override while the lowered ref kept the spec's key, so a
    // run with `--inbox-var` wrote one variable and told the operator about
    // another — the worst shape a mistake can take here, because the operator
    // reaching for the flag is already correcting a wrong match.
    return {
      server,
      inboxId: credentialSlot(
        `mcp_servers.${server}.env.${inboxVar}`,
        override !== undefined || inboxKey === undefined ? `$${inboxVar}` : env[inboxKey],
      ),
      apiKey:
        apiKeyKey === undefined
          ? undefined
          : credentialSlot(`mcp_servers.${server}.env.${apiKeyKey}`, env[apiKeyKey]),
      // "The spec has a LIVE ref to the variable setup writes." An override
      // naming a different variable than the spec declares is not that: the
      // harness would keep reading its own key while setup fills another, so
      // the operator has an edit to make either way.
      declared: inboxKey !== undefined && (override === undefined || override === inboxKey),
      specInboxVar: inboxKey,
      matchedByNameOnly: apiKeyKey === undefined,
    };
  }

  // Nothing declared, but the operator named a variable — take them at their
  // word. This is the commented-out case, and the only way through it.
  if (override !== undefined) {
    return {
      server: "(not declared in the spec)",
      inboxId: credentialSlot(`--inbox-var ${override}`, `$${override}`),
      apiKey: undefined,
      declared: false,
      specInboxVar: undefined,
      // The operator named the variable, so nothing was guessed.
      matchedByNameOnly: false,
    };
  }
  return undefined;
}

/**
 * Lower one credential-shaped spec value. An absent field is reported as an
 * env ref to nothing rather than thrown on — the spec may simply not declare
 * it yet, and setup's job is to tell the operator which variable to add.
 */
function credentialSlot(label: string, value: unknown): CredentialSlot {
  if (isMalformedEnvRef(value)) {
    throw new ServiceSetupError("harness", malformedEnvRefMessage(label, String(value)), {
      fix: `rewrite ${label} as $UPPER_SNAKE_CASE, or drop the leading "$" if it is a literal`,
    });
  }
  if (typeof value !== "string" || value === "") {
    return { label, ref: { kind: "env", name: "" } };
  }
  return { label, ref: lowerSecretString(value) };
}

/**
 * The env variable a credential slot writes to, or undefined when the spec
 * inlines a literal (nothing to write — the value is already in the file the
 * operator is editing) or declares nothing at all.
 */
export function slotEnvName(slot: CredentialSlot): string | undefined {
  return slot.ref.kind === "env" && slot.ref.name !== "" ? slot.ref.name : undefined;
}

/**
 * The public hostname for a harness: `<subdomain>.<zone>`. The subdomain
 * defaults to the spec name lowercased and slugified, which is what makes a
 * fleet's hostnames line up with its harness directories without the tool
 * knowing anything about the fleet.
 */
export function publicHostname(zone: string, subdomain: string): string {
  return `${subdomain}.${zone}`;
}

/** Slugify a spec name into a DNS label. */
export function hostnameLabel(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  if (label === "") {
    throw new ServiceSetupError("harness", `cannot derive a hostname label from "${name}"`, {
      fix: "pass --hostname explicitly",
    });
  }
  return label;
}

/** Narrow an unknown to a record without `any`. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(rec: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function readPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : undefined;
}
