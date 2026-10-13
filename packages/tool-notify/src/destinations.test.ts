/**
 * SmsSend and PushNotify address only destinations the operator listed
 * (C031, security-5#12).
 *
 * EmailSend has always refused an address outside allowed_recipients, but
 * NotifyConfig had no list for a phone number or a push target, so SmsSend
 * and PushNotify contacted whatever the call named: a premium-rate number
 * pumped at the operator's expense, or any device the provider can reach.
 * A permission rule cannot stand in for the list. Now
 * `allowed_sms_recipients` and `allowed_push_targets` are checked before
 * anything is built or sent, and, like every allow-list here, an empty one
 * refuses everyone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { preparePermissionSubject } from "@crewhaus/tool-executor";
import {
  compilePattern,
  matchesPattern,
  normalizePhoneNumber,
} from "@crewhaus/tool-permission-matcher";
import {
  __setPrivateHostsAllowedForTest,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  pushNotify,
  registerNotifyConfig,
  smsSend,
} from "./index";
import {
  NotifyPermissionError,
  buildNotifyConfig,
  destinationRefusal,
  normalizeSmsNumber,
} from "./net";

let wire: Array<Record<string, unknown>> = [];
let http: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      wire.push((await req.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ sid: "SM1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${http.port}`;
});

afterAll(() => {
  http.stop(true);
});

const providers = () => ({
  gw: { endpoint: `${origin}/sms`, fields: { to: "To", body: "Body" }, idPath: "sid" },
  pinned: {
    endpoint: `${origin}/sms`,
    fields: { body: "Body" },
    staticFields: { To: "+15550001111" },
  },
});

beforeEach(() => {
  wire = [];
  __setPrivateHostsAllowedForTest(true);
  registerNotifyConfig({
    allowed_origins: [origin],
    allowed_sms_recipients: ["+15550001111", "+4420*"],
    allowed_push_targets: ["topic:ops-*", "exact-token"],
    providers: providers(),
  });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetNotifyConfig();
  _resetIdempotencyLedger();
});

const sms = async (to: string, extra: Record<string, unknown> = {}, ctx?: unknown) =>
  String(await smsSend.execute({ provider: "gw", to, body: "x", ...extra }, ctx as never));
const push = async (to: string, ctx?: unknown) =>
  String(await pushNotify.execute({ provider: "gw", to, body: "x" }, ctx as never));

describe("SmsSend reaches only a listed number", () => {
  test("a number outside the list is refused and nothing is sent", async () => {
    const out = await sms("+882351234567");
    expect(out).toMatch(/^nothing was sent: "\+882351234567" is not in allowed_sms_recipients/);
    expect(wire).toEqual([]);
  });

  test("a listed number is matched whatever separators it is written with, and sent in E.164 form", async () => {
    for (const to of ["+1 (555) 000-1111", "(+1)5550001111", "-+1.555.000.1111"]) {
      expect(JSON.parse(await sms(to)).sent).toBe(true);
    }
    // The number the list and a permission rule decided on, not the call's
    // spelling of it, which a gateway might read as another number.
    expect(wire).toEqual([1, 2, 3].map(() => ({ To: "+15550001111", Body: "x" })));
  });

  test("a prefix entry admits the numbers under it, and only those", async () => {
    expect(JSON.parse(await sms("+442071234567")).sent).toBe(true);
    expect(await sms("+442171234567")).toContain("not in allowed_sms_recipients");
    expect(wire.length).toBe(1);
  });

  test("a destination that is not an E.164 number matches nothing, and says why", async () => {
    const out = await sms("5550001111");
    expect(out).toContain("matched in E.164 form");
    expect(wire).toEqual([]);
  });

  test("an empty list, or none at all, refuses everyone", async () => {
    for (const block of [
      { allowed_origins: [origin], allowed_sms_recipients: [], providers: providers() },
      { allowed_origins: [origin], providers: providers() },
    ]) {
      const out = await sms("+15550001111", {}, { toolConfig: block });
      expect(out).toContain("an empty allow-list refuses everyone");
    }
    expect(wire).toEqual([]);
  });

  test("a provider that pins the number in staticFields needs no list: the call's number is never sent", async () => {
    const out = JSON.parse(
      String(
        await smsSend.execute({ provider: "pinned", to: "+882351234567", body: "x" }, {
          toolConfig: { allowed_origins: [origin], providers: providers() },
        } as never),
      ),
    );
    expect(out.sent).toBe(true);
    expect(wire).toEqual([{ To: "+15550001111", Body: "x" }]);
  });

  test("an idempotency key reused for a number the list no longer admits is refused, not replayed", async () => {
    expect(JSON.parse(await sms("+15550001111", { idempotencyKey: "k1" })).sent).toBe(true);
    const out = await sms(
      "+15550001111",
      { idempotencyKey: "k1" },
      { toolConfig: { allowed_origins: [origin], providers: providers() } },
    );
    expect(out).toContain("not in allowed_sms_recipients");
    expect(wire.length).toBe(1);
  });
});

describe("PushNotify reaches only a listed target", () => {
  test("an exact target and a prefixed topic are sent; anything else is refused", async () => {
    expect(JSON.parse(await push("exact-token")).sent).toBe(true);
    expect(JSON.parse(await push("topic:ops-db")).sent).toBe(true);
    for (const target of ["topic:marketing", "exact-token-2", "attacker-device"]) {
      const out = await push(target);
      expect(out).toMatch(/^nothing was sent: that push target is not in allowed_push_targets/);
      expect(out).not.toContain(target);
    }
    expect(wire.map((w) => w["To"])).toEqual(["exact-token", "topic:ops-db"]);
  });

  test("a target is sent as the list compared it, without the spaces around it", async () => {
    expect(JSON.parse(await push(" exact-token\n")).sent).toBe(true);
    expect(wire.map((w) => w["To"])).toEqual(["exact-token"]);
  });

  test("an empty list refuses everyone", async () => {
    const out = await push("exact-token", {
      toolConfig: { allowed_origins: [origin], providers: providers() },
    });
    expect(out).toContain("an empty allow-list refuses everyone");
    expect(wire).toEqual([]);
  });
});

describe("the destination lists are checked when the harness starts", () => {
  test.each([
    [{ allowed_sms_recipients: ["12345"] }],
    [{ allowed_sms_recipients: ["*"] }],
    [{ allowed_sms_recipients: ["+*"] }],
    [{ allowed_sms_recipients: ["+0123"] }],
    [{ allowed_sms_recipients: ["+1234567890123456"] }],
    [{ allowed_sms_recipients: "+15550001111" }],
    [{ allowed_push_targets: ["*"] }],
    [{ allowed_push_targets: ["a*b"] }],
    [{ allowed_push_targets: [""] }],
  ])("%p is refused", (block) => {
    expect(() => buildNotifyConfig(block as never)).toThrow(NotifyPermissionError);
  });

  test("numbers are stored normalised, both spellings are read, camelCase first", () => {
    expect(
      buildNotifyConfig({ allowedSmsRecipients: ["+1 (555) 000-1111", "+44 20*"] })
        .allowedSmsRecipients,
    ).toEqual(["+15550001111", "+4420*"]);
    expect(buildNotifyConfig({ allowed_push_targets: [" t "] }).allowedPushTargets).toEqual(["t"]);
    expect(normalizeSmsNumber(" +1.555.000.1111 ")).toBe("+15550001111");
  });
});

// critic10 (0.7.1): the gate read a number only when its `+` came first,
// while this tool takes the separators out wherever they are, so
// `(+1)5550001111` was sent to a number a deny on `+15550001111` did not see.
describe("a permission rule reads a number as SmsSend does", () => {
  test("one implementation: the tool's normaliser is the permission matcher's", () => {
    expect(normalizeSmsNumber).toBe(normalizePhoneNumber);
  });

  test("every spelling the tool would send meets a deny on its number, and no other number's", () => {
    const listed = buildNotifyConfig({
      allowed_sms_recipients: ["+1*", "+2*", "+3*", "+4*", "+5*", "+6*", "+7*", "+8*", "+9*"],
    });
    const seps = [" ", "-", ".", "(", ")"];
    const spaces = [" ", "\t", "\n", "\u00a0", "\u3000", "\ufeff"];
    const spellings = new Set<string>();
    for (const number of ["+15550001111", "+442071234567", "+12"]) {
      for (let p = 0; p <= number.length; p++) {
        for (const sep of seps) spellings.add(number.slice(0, p) + sep + number.slice(p));
        for (let q = p; q <= number.length; q++) {
          spellings.add(`${number.slice(0, p)}(${number.slice(p, q)})${number.slice(q)}`);
          spellings.add(`${number.slice(0, p)}.-${number.slice(p, q)} ${number.slice(q)}`);
        }
      }
      for (const space of spaces) spellings.add(`${space}(${number.slice(0, 2)})${space}`);
    }
    const deny = (rule: string, to: string): boolean => {
      const subject = preparePermissionSubject(smsSend, { provider: "gw", to, body: "x" });
      if (!subject.ok) throw new Error(subject.reason);
      return matchesPattern(compilePattern(rule), "SmsSend", subject.input, {
        polarity: "restrict",
        operativeValues: subject.operativeValues,
      });
    };
    const sent = [...spellings].filter((to) => destinationRefusal(to, "sms", listed) === null);
    // The sweep's own size, so a generator that stopped producing spellings fails.
    expect(sent.length).toBe(579);
    const missed = sent.filter((to) => !deny(`SmsSend(${normalizeSmsNumber(to)})`, to));
    const other = sent.filter((to) => deny(`SmsSend(${normalizeSmsNumber(to)}9)`, to));
    expect({ missed, other }).toEqual({ missed: [], other: [] });
  }, 30_000);
});
