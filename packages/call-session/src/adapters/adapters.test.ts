/**
 * Section 30 — telephony adapter contract tests.
 */
import { describe, expect, test } from "bun:test";
import { CallSessionError } from "../index";
import { createLiveKitSipAdapter } from "./livekit-sip";
import { createTwilioTelephonyAdapter } from "./twilio";

describe("twilio telephony adapter", () => {
  test("dial POSTs to Calls.json with from/to params", async () => {
    let observedUrl = "";
    let observedAuth = "";
    let observedBody = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      observedBody = init?.body as string;
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "AC123",
      authToken: "tok",
      fromNumber: "+15551234567",
      fetchImpl,
    });
    await adapter.dial("+15559876543");
    expect(observedUrl).toContain("/Accounts/AC123/Calls.json");
    expect(observedAuth.startsWith("Basic ")).toBe(true);
    expect(observedBody).toContain("From=%2B15551234567");
    expect(observedBody).toContain("To=%2B15559876543");
  });

  test("hold/resume update the active call", async () => {
    let updates = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST" && (init.body as string).includes("Status=")) updates++;
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("+2");
    await adapter.hold();
    await adapter.resume();
    expect(updates).toBe(2);
  });

  test("missing config throws", () => {
    expect(() =>
      createTwilioTelephonyAdapter({
        accountSid: "",
        authToken: "t",
        fromNumber: "+1",
      }),
    ).toThrow(CallSessionError);
  });
});

describe("livekit-sip telephony adapter", () => {
  test("dial POSTs to CreateSIPParticipant", async () => {
    let observedUrl = "";
    let observedBody = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body as string;
      return new Response(JSON.stringify({ participant_id: "p1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("sip:test@example.com");
    expect(observedUrl).toContain("/twirp/livekit.SIP/CreateSIPParticipant");
    const parsed = JSON.parse(observedBody) as { sip_call_to: string };
    expect(parsed.sip_call_to).toBe("sip:test@example.com");
  });

  test("transfer requires active call", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.transfer("sip:other@x.com")).rejects.toBeInstanceOf(CallSessionError);
  });

  test("missing config throws", () => {
    expect(() =>
      createLiveKitSipAdapter({
        url: "",
        apiKey: "k",
        apiSecret: "s",
        fromNumber: "+1",
      }),
    ).toThrow(CallSessionError);
  });
});
