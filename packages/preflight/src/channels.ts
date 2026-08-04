/**
 * Channel boot-gate env checks, extracted from the CLI's
 * `channel provision|verify` offline phase so any manager can predict —
 * without a network call — whether a compiled channel daemon will boot.
 *
 * The compiled daemon gates its boot on every secret env-ref its configured
 * channels require (its startup check exits 2 on the same set), so "these
 * checks are green" and "the daemon boots" cannot drift apart. The checks
 * are pure functions of the lowered channel config + an injected env — this
 * is exactly what `crewhaus channel verify --offline` runs, and the prefix
 * every online run starts with.
 *
 * Inputs are the STRUCTURAL secret-ref shape (`SecretRef` mirrors the IR's
 * `IrSecretRef`), so callers can pass either a compiler-lowered
 * `IrChannels` or the output of {@link lowerSpecChannels}, which applies
 * the same Section-12 grammar to a raw parsed spec's `channels:` block.
 */

import {
  type SecretRef,
  isMalformedEnvRef,
  lowerSecretString,
  malformedEnvRefMessage,
} from "./secret-grammar";
import {
  type PreflightCheck,
  type PreflightEnv,
  type PreflightItem,
  checkToItem,
  isEnvSet,
} from "./types";

/** Platforms with a platform-side provision/verify flow. */
export const CHANNEL_PLATFORMS = ["slack", "telegram", "discord"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/**
 * Every channel whose secret fields the compiled daemon gates its boot on —
 * not just the three with a platform API. Boot-gate checks walk THIS list.
 */
export const CHANNEL_ENV_PLATFORMS = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
] as const;
export type ChannelEnvPlatform = (typeof CHANNEL_ENV_PLATFORMS)[number];

/** Human titles per platform (check labels / item messages). */
export const CHANNEL_PLATFORM_TITLE: Record<ChannelEnvPlatform, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
};

/** Structural subset of the lowered channels block: just the secret fields
 *  the boot gate reads. A full `IrChannels` assigns to this. */
export type ChannelSecretConfigs = {
  readonly slack?: { readonly botToken: SecretRef; readonly signingSecret: SecretRef };
  readonly telegram?: { readonly botToken: SecretRef; readonly secretToken: SecretRef };
  readonly discord?: {
    readonly applicationId: SecretRef;
    readonly botToken: SecretRef;
    readonly publicKeyHex: SecretRef;
  };
  readonly whatsapp?: {
    readonly phoneNumberId: SecretRef;
    readonly accessToken: SecretRef;
    readonly appSecret: SecretRef;
    readonly verifyToken?: SecretRef;
  };
  readonly imessage?: { readonly chatDbPath?: SecretRef; readonly cursorPath?: SecretRef };
};

/** One boot-gated secret field: its spec path (`label`), the human `title`
 *  used as a check label, and the lowered ref. */
export type ChannelSecretRefEntry = {
  readonly label: string;
  readonly title: string;
  readonly ref: SecretRef;
};

/**
 * The secret fields a platform's daemon REQUIRES at boot — a mirror of the
 * channel emitter's required-env derivation, field for field:
 *   slack     botToken + signingSecret (appToken is reserved for a future
 *             Socket-Mode path — parsed but unused, so not required)
 *   telegram  botToken + secretToken
 *   discord   applicationId + botToken + publicKeyHex
 *   whatsapp  phoneNumberId + accessToken + appSecret (+ verifyToken once
 *             declared — Meta's callback handshake fails closed without it)
 *   imessage  chatDbPath / cursorPath, ONLY when written as env refs (both
 *             are optional paths, not secrets: a literal is a legitimate
 *             spec value the daemon never gates on)
 */
export function platformSecretRefs(
  platform: ChannelEnvPlatform,
  channels: ChannelSecretConfigs,
): ReadonlyArray<ChannelSecretRefEntry> {
  switch (platform) {
    case "slack": {
      const slack = channels.slack;
      if (slack === undefined) return [];
      return [
        { label: "channels.slack.botToken", title: "Slack bot token", ref: slack.botToken },
        {
          label: "channels.slack.signingSecret",
          title: "Slack signing secret",
          ref: slack.signingSecret,
        },
      ];
    }
    case "telegram": {
      const telegram = channels.telegram;
      if (telegram === undefined) return [];
      return [
        {
          label: "channels.telegram.botToken",
          title: "Telegram bot token",
          ref: telegram.botToken,
        },
        {
          label: "channels.telegram.secretToken",
          title: "Telegram secret token (daemon side; Telegram never returns it)",
          ref: telegram.secretToken,
        },
      ];
    }
    case "discord": {
      const discord = channels.discord;
      if (discord === undefined) return [];
      return [
        {
          label: "channels.discord.applicationId",
          title: "Discord application id",
          ref: discord.applicationId,
        },
        { label: "channels.discord.botToken", title: "Discord bot token", ref: discord.botToken },
        {
          label: "channels.discord.publicKeyHex",
          title: "Discord public key",
          ref: discord.publicKeyHex,
        },
      ];
    }
    case "whatsapp": {
      const whatsapp = channels.whatsapp;
      if (whatsapp === undefined) return [];
      const entries: ChannelSecretRefEntry[] = [
        {
          label: "channels.whatsapp.phoneNumberId",
          title: "WhatsApp phone number id",
          ref: whatsapp.phoneNumberId,
        },
        {
          label: "channels.whatsapp.accessToken",
          title: "WhatsApp access token",
          ref: whatsapp.accessToken,
        },
        {
          label: "channels.whatsapp.appSecret",
          title: "WhatsApp app secret",
          ref: whatsapp.appSecret,
        },
      ];
      if (whatsapp.verifyToken !== undefined) {
        entries.push({
          label: "channels.whatsapp.verifyToken",
          title: "WhatsApp verify token",
          ref: whatsapp.verifyToken,
        });
      }
      return entries;
    }
    case "imessage": {
      const imessage = channels.imessage;
      if (imessage === undefined) return [];
      const entries: ChannelSecretRefEntry[] = [];
      if (imessage.chatDbPath?.kind === "env") {
        entries.push({
          label: "channels.imessage.chatDbPath",
          title: "iMessage chat.db path",
          ref: imessage.chatDbPath,
        });
      }
      if (imessage.cursorPath?.kind === "env") {
        entries.push({
          label: "channels.imessage.cursorPath",
          title: "iMessage cursor path",
          ref: imessage.cursorPath,
        });
      }
      return entries;
    }
  }
}

/**
 * The lowering of a field the spec gave no usable value: an EMPTY literal.
 *
 * `SecretRef` is a structural mirror of the IR's `IrSecretRef` and must stay
 * interchangeable with it at every call site, so absence cannot become a
 * third variant. An empty literal is the honest degradation instead — every
 * walker still has a shape, and {@link envRefCheck} reports it as a failing
 * boot gate rather than as the "inline literal" a real pasted value is. A
 * spec that literally writes `botToken: ""` lands here too, and deserves the
 * same answer.
 */
export const ABSENT_SECRET: SecretRef = { kind: "literal", value: "" };

/** One boot-gate check for one secret field (offline: env presence only). */
export function envRefCheck(entry: ChannelSecretRefEntry, env: PreflightEnv): PreflightCheck {
  const { title: label, label: fieldLabel, ref } = entry;
  if (ref.kind === "literal") {
    if (ref.value === "") {
      return {
        label,
        pass: false,
        reason: `${fieldLabel} has no usable value in the spec — the daemon exits at boot without it`,
      };
    }
    return {
      label,
      pass: true,
      warn: true,
      reason: `${fieldLabel} is an inline literal — prefer a $ENV ref so the value stays out of the spec`,
    };
  }
  const set = isEnvSet(env, ref.name);
  return set
    ? { label, pass: true }
    : {
        label,
        pass: false,
        reason: `${fieldLabel} references $${ref.name} but it is unset — the daemon exits at boot without it`,
      };
}

/**
 * The boot-gate phase for one channel: a check per secret field the
 * compiled daemon requires at boot. Pure (env only) and therefore
 * deterministic — the offline mode of `crewhaus channel verify`, and the
 * prefix every online run starts with.
 */
export function channelEnvChecks(
  platform: ChannelEnvPlatform,
  channels: ChannelSecretConfigs,
  env: PreflightEnv,
): PreflightCheck[] {
  return platformSecretRefs(platform, channels).map((entry) => envRefCheck(entry, env));
}

/**
 * Doctor-style per-platform summary checks: one check per configured
 * platform (slack/telegram/discord), asserting that every secret env-ref
 * the compiled daemon requires at boot is actually set. Message-compatible
 * with the CLI doctor's channel section. Offline by design — live platform
 * probes (granted scopes, webhook state) belong to `crewhaus channel
 * verify`, which the failure reason points at.
 */
export function buildChannelEnvSummaryChecks(
  channels: ChannelSecretConfigs,
  env: PreflightEnv,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  for (const platform of CHANNEL_PLATFORMS) {
    const refs = platformSecretRefs(platform, channels);
    if (refs.length === 0) continue;
    const envNames = refs.flatMap((r) => (r.ref.kind === "env" ? [r.ref.name] : []));
    // A field the spec never gave a value is boot-fatal exactly like an
    // unset env ref, but it names no variable — so it is listed by its spec
    // path. Folding it in here keeps the doctor's one-line-per-platform
    // summary from passing a channel that cannot start.
    const missing = [
      ...envNames.filter((name) => !isEnvSet(env, name)).map((name) => `$${name}`),
      ...refs.filter((r) => r.ref.kind === "literal" && r.ref.value === "").map((r) => r.label),
    ];
    const label =
      envNames.length > 0
        ? `${CHANNEL_PLATFORM_TITLE[platform]} channel env (${envNames.join(", ")})`
        : `${CHANNEL_PLATFORM_TITLE[platform]} channel env (inline literals)`;
    checks.push(
      missing.length === 0
        ? { label, pass: true }
        : {
            label,
            pass: false,
            reason: `unset: ${missing.join(", ")} — the compiled daemon exits at boot without them; run \`crewhaus channel verify\` for live platform probes`,
          },
    );
  }
  return checks;
}

/** Result of lowering a raw spec channels block: the structural secret
 *  configs, any values the compiler would REJECT (malformed `$…` on a
 *  credential-shaped field — compilation fails before a daemon exists), and
 *  the required fields the spec never gave a usable value. */
export type LoweredSpecChannels = {
  readonly channels: ChannelSecretConfigs;
  readonly compileErrors: ReadonlyArray<{ readonly label: string; readonly message: string }>;
  /** Required credential fields with no usable value in the spec — absent,
   *  empty, or the wrong YAML type. Each carries the sentence that names the
   *  fault; {@link channelItems} renders one blocking item per entry. */
  readonly missing: ReadonlyArray<{ readonly label: string; readonly message: string }>;
};

/** The YAML type a raw scalar actually is, for a message that tells the
 *  operator what they wrote rather than only what was expected. */
function yamlTypeName(value: unknown): string {
  if (value === null) return "an empty value (YAML null)";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return `a ${typeof value}`;
}

/**
 * Apply the Section-12 secret grammar to a RAW parsed spec `channels:`
 * block, producing the same secret refs the compiler's lowering would.
 * Credential-shaped fields (every channel secret except the iMessage
 * paths, which are path-like and stay permissive) reject malformed `$…`
 * values exactly like the compiler does — those come back as
 * `compileErrors` so preflight can report "compilation will fail" instead
 * of a misleading env check.
 *
 * THE INPUT IS UNVALIDATED, AND THAT IS THE POINT. The document reaching
 * here has not been through the spec schema — a manager calls this to
 * explain a spec that does not work yet. So every field is read as
 * `unknown`: a channel block missing a required key, a `slack:` that parsed
 * as null, an `applicationId: 1234` the operator forgot to quote. Each one
 * becomes a REPORTED finding (`missing` or `compileErrors`) and the lowering
 * continues. Throwing here would take out every route that predicts boot
 * behaviour — including the fleet-wide credentials matrix, which folds over
 * every registered harness and would lose the whole screen to one bad spec.
 */
export function lowerSpecChannels(raw: unknown): LoweredSpecChannels {
  const channels = asBlock(raw) ?? {};
  const compileErrors: Array<{ label: string; message: string }> = [];
  const missing: Array<{ label: string; message: string }> = [];

  /** One credential-shaped field, lowered or reported — never thrown on. */
  const credential = (label: string, value: unknown): SecretRef => {
    if (value === undefined) {
      missing.push({
        label,
        message: `${label} is required but the spec does not declare it — the compiled daemon exits 2 at boot without it`,
      });
      return ABSENT_SECRET;
    }
    if (typeof value !== "string") {
      missing.push({
        label,
        message: `${label} must be a string, but the spec declares ${yamlTypeName(value)} — quote the value (an unquoted 1234 is a YAML number, not a token)`,
      });
      return ABSENT_SECRET;
    }
    if (value === "") {
      missing.push({
        label,
        message: `${label} is declared but empty — the compiled daemon exits 2 at boot without it`,
      });
      return ABSENT_SECRET;
    }
    if (isMalformedEnvRef(value)) {
      compileErrors.push({ label, message: malformedEnvRefMessage(label, value) });
      // Degrade to a literal so downstream checks still have a shape; the
      // compileErrors entry is what surfaces (as blocking).
      return { kind: "literal", value };
    }
    return lowerSecretString(value);
  };

  /** One path-like field: absent stays absent, a non-string is reported. */
  const pathField = (label: string, value: unknown): SecretRef | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      missing.push({
        label,
        message: `${label} must be a path string, but the spec declares ${yamlTypeName(value)}`,
      });
      return undefined;
    }
    return lowerSecretString(value);
  };

  /** A declared platform's block, or a reported fault. `slack:` with nothing
   *  under it parses as null — an unfinished spec, not a missing one. */
  const platformBlock = (label: string, value: unknown): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    const block = asBlock(value);
    if (block === undefined) {
      missing.push({
        label,
        message: `${label} must be a mapping of secret fields, but the spec declares ${yamlTypeName(value)}`,
      });
      return undefined;
    }
    return block;
  };

  const out: {
    slack?: ChannelSecretConfigs["slack"];
    telegram?: ChannelSecretConfigs["telegram"];
    discord?: ChannelSecretConfigs["discord"];
    whatsapp?: ChannelSecretConfigs["whatsapp"];
    imessage?: ChannelSecretConfigs["imessage"];
  } = {};

  const slack = platformBlock("channels.slack", channels["slack"]);
  if (slack !== undefined) {
    out.slack = {
      botToken: credential("channels.slack.botToken", slack["botToken"]),
      signingSecret: credential("channels.slack.signingSecret", slack["signingSecret"]),
    };
  }
  const telegram = platformBlock("channels.telegram", channels["telegram"]);
  if (telegram !== undefined) {
    out.telegram = {
      botToken: credential("channels.telegram.botToken", telegram["botToken"]),
      secretToken: credential("channels.telegram.secretToken", telegram["secretToken"]),
    };
  }
  const discord = platformBlock("channels.discord", channels["discord"]);
  if (discord !== undefined) {
    out.discord = {
      applicationId: credential("channels.discord.applicationId", discord["applicationId"]),
      botToken: credential("channels.discord.botToken", discord["botToken"]),
      publicKeyHex: credential("channels.discord.publicKeyHex", discord["publicKeyHex"]),
    };
  }
  const whatsapp = platformBlock("channels.whatsapp", channels["whatsapp"]);
  if (whatsapp !== undefined) {
    const verifyToken = whatsapp["verifyToken"];
    out.whatsapp = {
      phoneNumberId: credential("channels.whatsapp.phoneNumberId", whatsapp["phoneNumberId"]),
      accessToken: credential("channels.whatsapp.accessToken", whatsapp["accessToken"]),
      appSecret: credential("channels.whatsapp.appSecret", whatsapp["appSecret"]),
      ...(verifyToken !== undefined
        ? { verifyToken: credential("channels.whatsapp.verifyToken", verifyToken) }
        : {}),
    };
  }
  const imessage = platformBlock("channels.imessage", channels["imessage"]);
  if (imessage !== undefined) {
    // Path-like fields keep the permissive lowering (a literal
    // `$HOME/...`-free path is a legitimate value; malformed `$` is not
    // a compile error here).
    const chatDbPath = pathField("channels.imessage.chatDbPath", imessage["chatDbPath"]);
    const cursorPath = pathField("channels.imessage.cursorPath", imessage["cursorPath"]);
    out.imessage = {
      ...(chatDbPath !== undefined ? { chatDbPath } : {}),
      ...(cursorPath !== undefined ? { cursorPath } : {}),
    };
  }

  return { channels: out, compileErrors, missing };
}

/** A parsed YAML mapping, or undefined for anything else (scalar, list,
 *  null). Arrays are excluded deliberately: a list under `slack:` is a spec
 *  mistake, not a block with numeric keys. */
function asBlock(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The channels area of the preflight report: per-secret-field boot-gate
 * items across all five env-gated platforms, plus blocking items for any
 * value the compiler would reject outright. Missing env refs are BLOCKING —
 * the compiled daemon's startup check exits 2 on the same set, so "start
 * anyway" is never honest for these.
 */
export function channelItems(lowered: LoweredSpecChannels, env: PreflightEnv): PreflightItem[] {
  const items: PreflightItem[] = [];
  for (const err of lowered.compileErrors) {
    items.push({
      id: `channels.compile.${err.label}`,
      area: "channels",
      level: "blocking",
      message: `compilation will fail: ${err.message}`,
    });
  }
  // A field with no usable value gets ONE item, in the slot its boot-gate
  // check would have occupied, carrying the sentence that names the actual
  // fault — "absent", "empty" and "unquoted number" are three different
  // mistakes and the generic gate message would blur all three.
  const unusable = new Map(lowered.missing.map((entry) => [entry.label, entry.message] as const));
  const rendered = new Set<string>();
  for (const platform of CHANNEL_ENV_PLATFORMS) {
    for (const entry of platformSecretRefs(platform, lowered.channels)) {
      const absent = unusable.get(entry.label);
      if (absent !== undefined) {
        rendered.add(entry.label);
        items.push({
          id: `channels.${entry.label}`,
          area: "channels",
          level: "blocking",
          message: absent,
          remediation: `set ${entry.label} in the spec's channels: block — a $UPPER_SNAKE env ref keeps the value out of the spec`,
        });
        continue;
      }
      const check = envRefCheck(entry, env);
      if (!check.pass && entry.ref.kind === "env") {
        items.push({
          id: `channels.${entry.label}`,
          area: "channels",
          level: "blocking",
          message: `will not boot: ${entry.ref.name} unset — ${entry.label} references $${entry.ref.name}; the compiled daemon exits 2 at boot without it`,
          remediation: `export ${entry.ref.name}=… (or run \`crewhaus channel verify\` for live platform probes)`,
          envVar: entry.ref.name,
        });
        continue;
      }
      items.push(
        checkToItem(
          `channels.${entry.label}`,
          "channels",
          check,
          entry.ref.kind === "env" ? { envVar: entry.ref.name } : {},
        ),
      );
    }
  }
  // Faults with no boot-gate slot to occupy: a platform block that is not a
  // mapping (so it produced no fields at all), or a malformed iMessage path.
  // Reporting them last still reports them — dropping them would leave the
  // operator with a channel that silently contributes nothing.
  for (const entry of lowered.missing) {
    if (rendered.has(entry.label)) continue;
    items.push({
      id: `channels.${entry.label}`,
      area: "channels",
      level: "blocking",
      message: entry.message,
    });
  }
  return items;
}
