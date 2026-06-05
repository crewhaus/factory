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

  test("missing authToken throws", () => {
    expect(() =>
      createTwilioTelephonyAdapter({ accountSid: "A", authToken: "", fromNumber: "+1" }),
    ).toThrow(/requires authToken/);
  });

  test("missing fromNumber throws", () => {
    expect(() =>
      createTwilioTelephonyAdapter({ accountSid: "A", authToken: "t", fromNumber: "" }),
    ).toThrow(/requires fromNumber/);
  });

  test("dial includes a TwiML Url and a basic auth header derived from sid:token", async () => {
    let observedAuth = "";
    let observedBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      observedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      observedBody = init?.body as string;
      return new Response(JSON.stringify({ sid: "CA999" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "AC123",
      authToken: "tok",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("+2");
    expect(observedBody).toContain("Url=https%3A%2F%2Fdemo.twilio.com");
    // Base64 of "AC123:tok".
    expect(observedAuth).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
  });

  test("answer is an adapter-level no-op", async () => {
    const fetchImpl = (async () => {
      throw new Error("answer must not hit the network");
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.answer()).resolves.toBeUndefined();
  });

  test("dial throws CallSessionError with status + body on a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.dial("+2")).rejects.toThrow(/Calls\.create returned 422: nope/);
  });

  test("callsUpdate throws CallSessionError on a non-ok response (via hold)", async () => {
    let firstCall = true;
    const fetchImpl = (async () => {
      if (firstCall) {
        firstCall = false;
        return new Response(JSON.stringify({ sid: "CA1" }), { status: 200 });
      }
      return new Response("denied", { status: 500 });
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("+2");
    await expect(adapter.hold()).rejects.toThrow(/Calls\.update returned 500: denied/);
  });

  test("hold/resume/transfer/end without an active call behave correctly", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sid: "x" }), { status: 200 })) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.hold()).rejects.toThrow(/no active call to hold/);
    await expect(adapter.resume()).rejects.toThrow(/no active call to resume/);
    await expect(adapter.transfer("+2")).rejects.toThrow(/no active call to transfer/);
    // end() with no active call is a silent no-op.
    await expect(adapter.end("bye")).resolves.toBeUndefined();
  });

  test("transfer posts a redirect Url with the encoded destination", async () => {
    let transferBody = "";
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls >= 2) transferBody = init?.body as string;
      return new Response(JSON.stringify({ sid: "CA1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("+2");
    await adapter.transfer("sip:agent@x.com");
    // The destination is encodeURIComponent-ed into the Url query string, then
    // the whole Url is form-urlencoded again as a POST body param — so the
    // caller-supplied URI ends up double-encoded. Decoding twice recovers it.
    const params = new URLSearchParams(transferBody);
    const url = new URL(params.get("Url") ?? "");
    expect(url.searchParams.get("to")).toBe("sip:agent@x.com");
    expect(transferBody).toContain("Method=POST");
  });

  test("end completes the active call then clears it (next end is a no-op)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push((init?.body as string) ?? "");
      void url;
      return new Response(JSON.stringify({ sid: "CA1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("+2");
    await adapter.end("done");
    expect(seen.some((b) => b.includes("Status=completed"))).toBe(true);
    const before = seen.length;
    await adapter.end("again"); // no active call → no network
    expect(seen.length).toBe(before);
  });

  test("kind is 'twilio'", () => {
    const adapter = createTwilioTelephonyAdapter({
      accountSid: "A",
      authToken: "t",
      fromNumber: "+1",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    expect(adapter.kind).toBe("twilio");
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

  test("each required field is validated independently", () => {
    expect(() =>
      createLiveKitSipAdapter({ url: "u", apiKey: "", apiSecret: "s", fromNumber: "+1" }),
    ).toThrow(/requires apiKey/);
    expect(() =>
      createLiveKitSipAdapter({ url: "u", apiKey: "k", apiSecret: "", fromNumber: "+1" }),
    ).toThrow(/requires apiSecret/);
    expect(() =>
      createLiveKitSipAdapter({ url: "u", apiKey: "k", apiSecret: "s", fromNumber: "" }),
    ).toThrow(/requires fromNumber/);
  });

  test("dial sends a bearer auth header and records the participant id", async () => {
    let observedAuth = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      observedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(JSON.stringify({ participant_id: "p42" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("sip:a@x.com");
    expect(observedAuth).toBe("Bearer k:s");
  });

  test("dial without participant_id in the response falls back to 'unknown' but stays active", async () => {
    // Response omits participant_id → activeParticipantId becomes "unknown"
    // (truthy), so a subsequent hold proceeds to the RPC rather than throwing.
    let holdHit = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("UpdateSIPParticipant")) holdHit = true;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("sip:a@x.com");
    await adapter.hold();
    expect(holdHit).toBe(true);
  });

  test("answer is an adapter-level no-op", async () => {
    const fetchImpl = (async () => {
      throw new Error("answer must not hit the network");
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.answer()).resolves.toBeUndefined();
  });

  test("rpc throws CallSessionError with method, status and body on a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("upstream boom", { status: 503 })) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.dial("sip:a@x.com")).rejects.toThrow(
      /CreateSIPParticipant returned 503: upstream boom/,
    );
  });

  test("hold and resume mute/unmute the active participant", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("UpdateSIPParticipant")) {
        bodies.push(JSON.parse(init?.body as string));
      }
      return new Response(JSON.stringify({ participant_id: "p1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("sip:a@x.com");
    await adapter.hold();
    await adapter.resume();
    expect(bodies).toEqual([
      { participant_id: "p1", muted: true },
      { participant_id: "p1", muted: false },
    ]);
  });

  test("hold/resume without an active call throw", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.hold()).rejects.toThrow(/no active call to hold/);
    await expect(adapter.resume()).rejects.toThrow(/no active call to resume/);
  });

  test("transfer forwards transfer_to for the active participant", async () => {
    let transferBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("TransferSIPParticipant")) {
        transferBody = JSON.parse(init?.body as string);
      }
      return new Response(JSON.stringify({ participant_id: "p1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("sip:a@x.com");
    await adapter.transfer("sip:b@x.com");
    expect(transferBody).toEqual({ participant_id: "p1", transfer_to: "sip:b@x.com" });
  });

  test("end deletes the active participant then clears it (next end is a no-op)", async () => {
    let deletes = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("DeleteSIPParticipant")) deletes += 1;
      return new Response(JSON.stringify({ participant_id: "p1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await adapter.dial("sip:a@x.com");
    await adapter.end("done");
    await adapter.end("again"); // no active participant → no extra delete
    expect(deletes).toBe(1);
  });

  test("end with no active call is a silent no-op", async () => {
    const fetchImpl = (async () => {
      throw new Error("end must not hit the network when idle");
    }) as unknown as typeof fetch;
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl,
    });
    await expect(adapter.end("never")).resolves.toBeUndefined();
  });

  test("kind is 'livekit-sip'", () => {
    const adapter = createLiveKitSipAdapter({
      url: "http://lk",
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+1",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    expect(adapter.kind).toBe("livekit-sip");
  });
});
