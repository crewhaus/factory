import { describe, expect, test } from "bun:test";
import {
  buildChannelEnvSummaryChecks,
  channelEnvChecks,
  channelItems,
  lowerSpecChannels,
  platformSecretRefs,
} from "./channels";
import { type SecretRef, isMalformedEnvRef } from "./secret-grammar";

const env = (name: string): SecretRef => ({ kind: "env", name });
const lit = (value: string): SecretRef => ({ kind: "literal", value });

const FIVE_CHANNELS = {
  slack: { botToken: env("SLACK_BOT_TOKEN"), signingSecret: env("SLACK_SIGNING_SECRET") },
  telegram: { botToken: env("TELEGRAM_BOT_TOKEN"), secretToken: lit("inline-not-a-secret") },
  discord: {
    applicationId: env("DISCORD_APP_ID"),
    botToken: env("DISCORD_BOT_TOKEN"),
    publicKeyHex: env("DISCORD_PUBLIC_KEY"),
  },
  whatsapp: {
    phoneNumberId: env("WA_PHONE_ID"),
    accessToken: env("WA_ACCESS_TOKEN"),
    appSecret: env("WA_APP_SECRET"),
  },
  imessage: { chatDbPath: lit("/Users/example/Library/Messages/chat.db") },
};

describe("platformSecretRefs", () => {
  test("mirrors the daemon's required set field for field", () => {
    expect(platformSecretRefs("slack", FIVE_CHANNELS).map((r) => r.label)).toEqual([
      "channels.slack.botToken",
      "channels.slack.signingSecret",
    ]);
    expect(platformSecretRefs("discord", FIVE_CHANNELS)).toHaveLength(3);
    expect(platformSecretRefs("whatsapp", FIVE_CHANNELS)).toHaveLength(3);
    // Literal imessage paths are legitimate values, never boot-gated.
    expect(platformSecretRefs("imessage", FIVE_CHANNELS)).toEqual([]);
    // Unconfigured platform contributes nothing.
    expect(platformSecretRefs("slack", {})).toEqual([]);
  });

  test("whatsapp verifyToken is required only once declared", () => {
    const withVerify = {
      whatsapp: { ...FIVE_CHANNELS.whatsapp, verifyToken: env("WA_VERIFY_TOKEN") },
    };
    expect(platformSecretRefs("whatsapp", withVerify)).toHaveLength(4);
  });

  test("imessage env-ref paths ARE boot-gated", () => {
    const refs = platformSecretRefs("imessage", {
      imessage: { chatDbPath: env("CHAT_DB_PATH") },
    });
    expect(refs.map((r) => r.label)).toEqual(["channels.imessage.chatDbPath"]);
  });
});

describe("channelEnvChecks (offline boot gate)", () => {
  test("set env refs pass; unset fail naming the var and the boot consequence", () => {
    const checks = channelEnvChecks("slack", FIVE_CHANNELS, { SLACK_BOT_TOKEN: "x" });
    expect(checks).toHaveLength(2);
    expect(checks[0]?.pass).toBe(true);
    expect(checks[1]?.pass).toBe(false);
    expect(checks[1]?.reason).toContain("$SLACK_SIGNING_SECRET");
    expect(checks[1]?.reason).toContain("exits at boot");
  });

  test("inline literals are warn-pass with a prefer-$ENV nudge", () => {
    const checks = channelEnvChecks("telegram", FIVE_CHANNELS, { TELEGRAM_BOT_TOKEN: "x" });
    expect(checks[1]?.pass).toBe(true);
    expect(checks[1]?.warn).toBe(true);
    expect(checks[1]?.reason).toContain("inline literal");
  });

  test("empty-string env counts as unset (matches the daemon's gate)", () => {
    const checks = channelEnvChecks("slack", FIVE_CHANNELS, {
      SLACK_BOT_TOKEN: "",
      SLACK_SIGNING_SECRET: "s",
    });
    expect(checks[0]?.pass).toBe(false);
  });
});

describe("buildChannelEnvSummaryChecks (doctor parity)", () => {
  test("one aggregate check per configured probe platform", () => {
    const checks = buildChannelEnvSummaryChecks(
      { slack: FIVE_CHANNELS.slack, telegram: FIVE_CHANNELS.telegram },
      { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "s", TELEGRAM_BOT_TOKEN: "t" },
    );
    expect(checks).toHaveLength(2);
    expect(checks[0]?.label).toContain("Slack channel env");
    expect(checks[0]?.pass).toBe(true);
    // Literal secretToken is exempt — only the env ref is listed.
    expect(checks[1]?.label).toBe("Telegram channel env (TELEGRAM_BOT_TOKEN)");
    expect(checks[1]?.pass).toBe(true);
  });

  test("missing env refs fail with the unset names and the channel-verify pointer", () => {
    const checks = buildChannelEnvSummaryChecks(
      { slack: FIVE_CHANNELS.slack },
      { SLACK_BOT_TOKEN: "x" },
    );
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.reason).toContain("$SLACK_SIGNING_SECRET");
    expect(checks[0]?.reason).toContain("crewhaus channel verify");
  });
});

describe("lowerSpecChannels (Section-12 grammar mirror)", () => {
  test("$UPPER_SNAKE lowers to env refs; literals stay literal", () => {
    const { channels, compileErrors } = lowerSpecChannels({
      slack: { botToken: "$SLACK_BOT_TOKEN", signingSecret: "not-ref-shaped" },
    });
    expect(compileErrors).toEqual([]);
    expect(channels.slack?.botToken).toEqual({ kind: "env", name: "SLACK_BOT_TOKEN" });
    expect(channels.slack?.signingSecret.kind).toBe("literal");
  });

  test("malformed $… on a credential field is a compile error, not an env check", () => {
    const { compileErrors } = lowerSpecChannels({
      slack: { botToken: "${SLACK_BOT_TOKEN}", signingSecret: "$slack_signing" },
    });
    expect(compileErrors).toHaveLength(2);
    expect(compileErrors[0]?.message).toContain("$UPPER_SNAKE_CASE");
  });

  test("imessage paths keep the permissive lowering", () => {
    const { channels, compileErrors } = lowerSpecChannels({
      imessage: { chatDbPath: "$HOME/Library/Messages/chat.db" },
    });
    expect(compileErrors).toEqual([]);
    expect(channels.imessage?.chatDbPath?.kind).toBe("literal");
  });
});

describe("channelItems", () => {
  test('missing secrets are blocking with the "will not boot" phrasing', () => {
    const lowered = lowerSpecChannels({
      slack: { botToken: "$SLACK_BOT_TOKEN", signingSecret: "$SLACK_SIGNING_SECRET" },
    });
    const items = channelItems(lowered, { SLACK_BOT_TOKEN: "x" });
    const missing = items.find((i) => i.id === "channels.channels.slack.signingSecret");
    expect(missing?.level).toBe("blocking");
    expect(missing?.message).toContain("will not boot: SLACK_SIGNING_SECRET unset");
    expect(missing?.message).toContain("exits 2 at boot");
    expect(missing?.envVar).toBe("SLACK_SIGNING_SECRET");
    expect(missing?.remediation).toContain("crewhaus channel verify");
    const present = items.find((i) => i.id === "channels.channels.slack.botToken");
    expect(present?.level).toBe("info");
  });

  test("a field with no usable value is blocking, and says which mistake it was", () => {
    const items = channelItems(lowerSpecChannels({ slack: { botToken: "$SLACK_BOT_TOKEN" } }), {
      SLACK_BOT_TOKEN: "x",
    });
    const item = items.find((i) => i.id === "channels.channels.slack.signingSecret");
    expect(item?.level).toBe("blocking");
    expect(item?.message).toContain("required but the spec does not declare it");
    expect(item?.remediation).toContain("channels: block");
    // NOT the warn-pass a genuinely pasted literal earns: an absent field is
    // not "a value in the wrong place", it is no value at all.
    expect(items.some((i) => i.message.includes("inline literal"))).toBe(false);
    // Exactly one item for the field — the boot-gate slot it would have had.
    expect(items.filter((i) => i.id === "channels.channels.slack.signingSecret")).toHaveLength(1);
  });

  test("compile errors surface as blocking; literals as warn", () => {
    const lowered = lowerSpecChannels({
      telegram: { botToken: "${TG_TOKEN}", secretToken: "inline-not-a-secret" },
    });
    const items = channelItems(lowered, {});
    expect(
      items.some((i) => i.level === "blocking" && i.message.includes("compilation will fail")),
    ).toBe(true);
    expect(items.some((i) => i.level === "warn" && i.message.includes("inline literal"))).toBe(
      true,
    );
  });
});

/**
 * An unfinished `channels:` block is a REPORT, never a throw.
 *
 * The regression: `lowerSpecChannels` handed each field straight to the
 * secret grammar, which called `.startsWith` on it. A channel block missing a
 * required field — the most common spec mistake, and precisely the thing this
 * package exists to name — therefore crashed the lowering, and with it every
 * route that predicts boot behaviour, including the fleet-wide credentials
 * matrix that folds over every registered harness.
 *
 * The rule these pin: preflight reads an UNVALIDATED document. Absent, empty,
 * wrong-typed and not-a-mapping are four different mistakes, each gets its own
 * sentence, and none of them may stop the lowering.
 */
describe("an unfinished channels block is reported, not thrown", () => {
  test("the grammar predicate tolerates a value the spec never declared", () => {
    expect(isMalformedEnvRef(undefined)).toBe(false);
    expect(isMalformedEnvRef(null)).toBe(false);
    expect(isMalformedEnvRef(1234)).toBe(false);
    // The real grammar is untouched.
    expect(isMalformedEnvRef("${SLACK_BOT_TOKEN}")).toBe(true);
    expect(isMalformedEnvRef("$SLACK_BOT_TOKEN")).toBe(false);
  });

  test("every platform's required fields survive being absent", () => {
    const { channels, missing, compileErrors } = lowerSpecChannels({
      slack: { botToken: "$SLACK_BOT_TOKEN" },
      telegram: { botToken: "$TG_BOT_TOKEN" },
      discord: { applicationId: "$D_APP", botToken: "$D_BOT" },
      whatsapp: { phoneNumberId: "$WA_PHONE" },
    });
    // Absence is not a malformed reference — a different fault, reported
    // under its own heading.
    expect(compileErrors).toEqual([]);
    expect(missing.map((m) => m.label)).toEqual([
      "channels.slack.signingSecret",
      "channels.telegram.secretToken",
      "channels.discord.publicKeyHex",
      "channels.whatsapp.accessToken",
      "channels.whatsapp.appSecret",
    ]);
    expect(missing[0]?.message).toContain("required but the spec does not declare it");
    // The shape survives, so every downstream walker still has one.
    expect(channels.slack?.signingSecret).toEqual({ kind: "literal", value: "" });
    expect(channels.slack?.botToken).toEqual({ kind: "env", name: "SLACK_BOT_TOKEN" });
  });

  test("an unquoted YAML scalar says what it is instead of posing as a token", () => {
    const { missing } = lowerSpecChannels({
      discord: { applicationId: 1234, botToken: "$D_BOT", publicKeyHex: "$D_KEY" },
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.label).toBe("channels.discord.applicationId");
    expect(missing[0]?.message).toContain("must be a string");
    expect(missing[0]?.message).toContain("a number");
  });

  test("a platform key with nothing under it is reported, not dereferenced", () => {
    // `slack:` with no fields parses as null — an unfinished spec, which is
    // the state an operator asks the manager to explain.
    const lowered = lowerSpecChannels({ slack: null, telegram: ["a"] });
    expect(lowered.channels.slack).toBeUndefined();
    expect(lowered.missing.map((m) => m.label)).toEqual(["channels.slack", "channels.telegram"]);
    // No boot-gate slot to occupy, so it is still reported on its own.
    const items = channelItems(lowered, {});
    expect(items.find((i) => i.id === "channels.channels.slack")?.level).toBe("blocking");
    expect(items.find((i) => i.id === "channels.channels.telegram")?.message).toContain("a list");
  });

  test("a declared-but-empty field is as boot-fatal as an absent one", () => {
    const lowered = lowerSpecChannels({
      slack: { botToken: "$SLACK_BOT_TOKEN", signingSecret: "" },
    });
    expect(lowered.missing[0]?.message).toContain("declared but empty");
    const checks = channelEnvChecks("slack", lowered.channels, { SLACK_BOT_TOKEN: "x" });
    expect(checks[1]?.pass).toBe(false);
    expect(checks[1]?.reason).toContain("no usable value");
    // and never the warn-pass an inline literal gets
    expect(checks[1]?.warn).toBeUndefined();
  });

  test("the doctor summary fails a platform whose field has no value", () => {
    const lowered = lowerSpecChannels({ slack: { botToken: "$SLACK_BOT_TOKEN" } });
    const checks = buildChannelEnvSummaryChecks(lowered.channels, { SLACK_BOT_TOKEN: "x" });
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.reason).toContain("channels.slack.signingSecret");
  });

  test("an iMessage path of the wrong type is dropped with a reason", () => {
    const lowered = lowerSpecChannels({ imessage: { chatDbPath: 5, cursorPath: "$CURSOR" } });
    expect(lowered.channels.imessage?.chatDbPath).toBeUndefined();
    expect(lowered.channels.imessage?.cursorPath).toEqual({ kind: "env", name: "CURSOR" });
    expect(lowered.missing[0]?.message).toContain("must be a path string");
  });

  test("a channels: block that is not a mapping at all lowers to nothing", () => {
    for (const raw of [undefined, null, "nope", 7, ["slack"]]) {
      expect(() => lowerSpecChannels(raw)).not.toThrow();
      expect(lowerSpecChannels(raw)).toEqual({ channels: {}, compileErrors: [], missing: [] });
    }
  });
});
