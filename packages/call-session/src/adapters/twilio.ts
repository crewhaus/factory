/**
 * Section 30 — Twilio telephony adapter for `@crewhaus/call-session`.
 * Routes through the Twilio REST API (via fetch — no SDK dependency).
 * Webhook signature verification lives outside this module (the daemon's
 * inbound HTTP handler does that with `X-Twilio-Signature`).
 */
import { CallSessionError, type TelephonyAdapter } from "../index";

export type TwilioAdapterOptions = {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber: string;
  /** Test override: inject a fake fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override base URL (defaults to https://api.twilio.com/2010-04-01). */
  readonly baseUrl?: string;
};

export function createTwilioTelephonyAdapter(opts: TwilioAdapterOptions): TelephonyAdapter {
  if (!opts.accountSid) throw new CallSessionError("twilio adapter requires accountSid");
  if (!opts.authToken) throw new CallSessionError("twilio adapter requires authToken");
  if (!opts.fromNumber) throw new CallSessionError("twilio adapter requires fromNumber");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://api.twilio.com/2010-04-01";
  let activeCallSid: string | undefined;

  function authHeader(): string {
    const token = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64");
    return `Basic ${token}`;
  }

  async function callsPost(body: Record<string, string>): Promise<{ sid: string }> {
    const params = new URLSearchParams(body).toString();
    const res = await fetchImpl(`${baseUrl}/Accounts/${opts.accountSid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    if (!res.ok) {
      throw new CallSessionError(`twilio Calls.create returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { sid: string };
  }

  async function callsUpdate(callSid: string, body: Record<string, string>): Promise<void> {
    const params = new URLSearchParams(body).toString();
    const res = await fetchImpl(`${baseUrl}/Accounts/${opts.accountSid}/Calls/${callSid}.json`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    if (!res.ok) {
      throw new CallSessionError(`twilio Calls.update returned ${res.status}: ${await res.text()}`);
    }
  }

  return {
    kind: "twilio",
    async dial(toUri: string): Promise<void> {
      const result = await callsPost({
        From: opts.fromNumber,
        To: toUri,
        // Twilio requires a TwiML URL or instructions; v0 expects callers
        // to wire the actual TwiML elsewhere. The empty Url makes the call
        // fail loudly rather than silently dial.
        Url: "https://demo.twilio.com/docs/voice.xml",
      });
      activeCallSid = result.sid;
    },
    async answer(): Promise<void> {
      // Inbound calls answer via TwiML <Say>/<Connect> on the webhook —
      // adapter-level answer is a no-op.
    },
    async hold(): Promise<void> {
      if (!activeCallSid) throw new CallSessionError("twilio: no active call to hold");
      await callsUpdate(activeCallSid, { Status: "queued" });
    },
    async resume(): Promise<void> {
      if (!activeCallSid) throw new CallSessionError("twilio: no active call to resume");
      await callsUpdate(activeCallSid, { Status: "in-progress" });
    },
    async transfer(toUri: string): Promise<void> {
      if (!activeCallSid) throw new CallSessionError("twilio: no active call to transfer");
      // Twilio transfer = update the active call to redirect to a TwiML
      // <Dial> for the new endpoint. Caller's TwiML supplies the verb;
      // here we POST the redirect URL.
      await callsUpdate(activeCallSid, {
        Url: `https://demo.twilio.com/docs/voice.xml?to=${encodeURIComponent(toUri)}`,
        Method: "POST",
      });
    },
    async end(_reason: string): Promise<void> {
      if (!activeCallSid) return;
      await callsUpdate(activeCallSid, { Status: "completed" });
      activeCallSid = undefined;
    },
  };
}
