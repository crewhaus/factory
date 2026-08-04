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

/** One boot-gate check for one secret field (offline: env presence only). */
export function envRefCheck(entry: ChannelSecretRefEntry, env: PreflightEnv): PreflightCheck {
  const { title: label, label: fieldLabel, ref } = entry;
  if (ref.kind === "literal") {
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
    const missing = envNames.filter((name) => !isEnvSet(env, name)).map((name) => `$${name}`);
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
 *  configs plus any values the compiler would REJECT (malformed `$…` on a
 *  credential-shaped field — compilation fails before a daemon exists). */
export type LoweredSpecChannels = {
  readonly channels: ChannelSecretConfigs;
  readonly compileErrors: ReadonlyArray<{ readonly label: string; readonly message: string }>;
};

type RawChannels = {
  readonly slack?: { botToken: string; signingSecret: string; appToken?: string };
  readonly telegram?: { botToken: string; secretToken: string };
  readonly discord?: { applicationId: string; botToken: string; publicKeyHex: string };
  readonly whatsapp?: {
    phoneNumberId: string;
    accessToken: string;
    appSecret: string;
    verifyToken?: string;
  };
  readonly imessage?: { chatDbPath?: string; cursorPath?: string };
};

/**
 * Apply the Section-12 secret grammar to a RAW parsed spec `channels:`
 * block, producing the same secret refs the compiler's lowering would.
 * Credential-shaped fields (every channel secret except the iMessage
 * paths, which are path-like and stay permissive) reject malformed `$…`
 * values exactly like the compiler does — those come back as
 * `compileErrors` so preflight can report "compilation will fail" instead
 * of a misleading env check.
 */
export function lowerSpecChannels(raw: unknown): LoweredSpecChannels {
  const channels = (raw ?? {}) as RawChannels;
  const compileErrors: Array<{ label: string; message: string }> = [];
  const credential = (label: string, value: string): SecretRef => {
    if (isMalformedEnvRef(value)) {
      compileErrors.push({ label, message: malformedEnvRefMessage(label, value) });
      // Degrade to a literal so downstream checks still have a shape; the
      // compileErrors entry is what surfaces (as blocking).
      return { kind: "literal", value };
    }
    return lowerSecretString(value);
  };

  const out: {
    slack?: ChannelSecretConfigs["slack"];
    telegram?: ChannelSecretConfigs["telegram"];
    discord?: ChannelSecretConfigs["discord"];
    whatsapp?: ChannelSecretConfigs["whatsapp"];
    imessage?: ChannelSecretConfigs["imessage"];
  } = {};

  if (channels.slack !== undefined) {
    out.slack = {
      botToken: credential("channels.slack.botToken", channels.slack.botToken),
      signingSecret: credential("channels.slack.signingSecret", channels.slack.signingSecret),
    };
  }
  if (channels.telegram !== undefined) {
    out.telegram = {
      botToken: credential("channels.telegram.botToken", channels.telegram.botToken),
      secretToken: credential("channels.telegram.secretToken", channels.telegram.secretToken),
    };
  }
  if (channels.discord !== undefined) {
    out.discord = {
      applicationId: credential("channels.discord.applicationId", channels.discord.applicationId),
      botToken: credential("channels.discord.botToken", channels.discord.botToken),
      publicKeyHex: credential("channels.discord.publicKeyHex", channels.discord.publicKeyHex),
    };
  }
  if (channels.whatsapp !== undefined) {
    out.whatsapp = {
      phoneNumberId: credential("channels.whatsapp.phoneNumberId", channels.whatsapp.phoneNumberId),
      accessToken: credential("channels.whatsapp.accessToken", channels.whatsapp.accessToken),
      appSecret: credential("channels.whatsapp.appSecret", channels.whatsapp.appSecret),
      ...(channels.whatsapp.verifyToken !== undefined
        ? {
            verifyToken: credential("channels.whatsapp.verifyToken", channels.whatsapp.verifyToken),
          }
        : {}),
    };
  }
  if (channels.imessage !== undefined) {
    out.imessage = {
      // Path-like fields keep the permissive lowering (a literal
      // `$HOME/...`-free path is a legitimate value; malformed `$` is not
      // a compile error here).
      ...(channels.imessage.chatDbPath !== undefined
        ? { chatDbPath: lowerSecretString(channels.imessage.chatDbPath) }
        : {}),
      ...(channels.imessage.cursorPath !== undefined
        ? { cursorPath: lowerSecretString(channels.imessage.cursorPath) }
        : {}),
    };
  }

  return { channels: out, compileErrors };
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
  for (const platform of CHANNEL_ENV_PLATFORMS) {
    for (const entry of platformSecretRefs(platform, lowered.channels)) {
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
  return items;
}
