/**
 * `fakeSlack`: a sink for the Web API calls a harness makes, attached through
 * the adapter's `apiBaseUrl` (or `SLACK_API_BASE_URL`) set to `${fake.url}/api`,
 * and a client that sends signed deliveries the way Slack does.
 *
 * The signature is computed here with this package's own HMAC. Importing the
 * adapter's would make a fidelity test check a function against itself.
 */
import { createHmac, randomBytes } from "node:crypto";
import { type RecordedRequest, recordRequest } from "./record";
import { type FakeService, assertLoopbackUrl, jsonResponse, serveLoopback } from "./serve";

export type FakeSlackScopes = {
  /** The scopes the installed token holds. */
  readonly granted: readonly string[];
  /** Method → the scopes it needs. A method not listed needs none. */
  readonly required: Readonly<Record<string, readonly string[]>>;
};

export type FakeSlackFault = {
  readonly status: 429;
  readonly times: number;
  /** Only this method; absent means every method. */
  readonly method?: string;
  /** Seconds, sent as `Retry-After`. */
  readonly retryAfter?: number;
};

export type FakeSlackOptions = {
  readonly scopes?: FakeSlackScopes;
  readonly faults?: readonly FakeSlackFault[];
  /** Signing secret for deliveries; generated at runtime when absent. */
  readonly signingSecret?: string;
};

export type SlackDeliveryOptions = {
  /** Epoch seconds to sign with; now when absent. */
  readonly ts?: number;
};

export type SlackEventOptions = SlackDeliveryOptions & {
  readonly eventId?: string;
  /** Send it a second time with the same `event_id`, as Slack's retry does. */
  readonly replay?: boolean;
};

/** What the receiver answered to one delivery. */
export type SlackDeliveryResult = { readonly status: number; readonly body: string };

/** The parts of a signed request: `headers` is a `Headers`, as a receiver sees. */
export type SignedRequest = { readonly headers: Headers; readonly body: string };

export type FakeSlack = FakeService & {
  /** `${url}/api`, the value for the adapter's `apiBaseUrl`. */
  readonly apiBaseUrl: string;
  readonly signingSecret: string;
  /** Recorded Web API calls, credentials masked, optionally for one method. */
  calls(method?: string): readonly RecordedRequest[];
  signedRequest(body: string, opts?: SlackDeliveryOptions): SignedRequest;
  deliverEvent(
    receiverUrl: string,
    payload: unknown,
    opts?: SlackEventOptions,
  ): Promise<readonly SlackDeliveryResult[]>;
  deliverInteraction(
    receiverUrl: string,
    payload: unknown,
    opts?: SlackDeliveryOptions,
  ): Promise<SlackDeliveryResult>;
  deliverCommand(
    receiverUrl: string,
    fields: Readonly<Record<string, string>>,
    opts?: SlackDeliveryOptions,
  ): Promise<SlackDeliveryResult>;
};

function replyFor(method: string, body: Record<string, unknown>): Record<string, unknown> | null {
  const channel = typeof body["channel"] === "string" ? body["channel"] : "C0FAKE";
  switch (method) {
    case "chat.postMessage":
      return { channel, ts: "1700000000.000100", message: { text: body["text"] ?? "" } };
    case "chat.update":
      return { channel, ts: body["ts"] ?? "1700000000.000100", text: body["text"] ?? "" };
    case "chat.postEphemeral":
      return { message_ts: "1700000000.000200" };
    case "reactions.add":
      return {};
    case "auth.test":
      return {
        url: "https://fake.slack.invalid/",
        team: "Fake",
        user: "fakebot",
        team_id: "T0FAKE",
        user_id: "U0FAKE",
        bot_id: "B0FAKE",
      };
    default:
      return null;
  }
}

/** Start a fake Slack. */
export function fakeSlack(opts: FakeSlackOptions = {}): FakeSlack {
  const signingSecret = opts.signingSecret ?? randomBytes(16).toString("hex");
  const recorded: Array<RecordedRequest & { readonly apiMethod: string }> = [];
  const faults = (opts.faults ?? []).map((fault) => ({ ...fault, left: fault.times }));

  const server = serveLoopback(async (req) => {
    const { recorded: entry, parsed } = await recordRequest(req);
    const match = /^\/api\/([A-Za-z.]+)$/.exec(entry.path);
    if (match === null || match[1] === undefined) {
      return jsonResponse(404, { ok: false, error: "unknown_method" });
    }
    const apiMethod = match[1];
    recorded.push({ ...entry, apiMethod });

    const fault = faults.find(
      (f) => f.left > 0 && (f.method === undefined || f.method === apiMethod),
    );
    if (fault !== undefined) {
      fault.left -= 1;
      return jsonResponse(
        fault.status,
        { ok: false, error: "ratelimited" },
        { "retry-after": String(fault.retryAfter ?? 1) },
      );
    }

    const needed = opts.scopes?.required[apiMethod] ?? [];
    const missing = needed.filter((scope) => opts.scopes?.granted.includes(scope) !== true);
    if (missing.length > 0) {
      return jsonResponse(200, {
        ok: false,
        error: "missing_scope",
        needed: missing.join(","),
        provided: (opts.scopes?.granted ?? []).join(","),
      });
    }

    const body = parsed !== null && typeof parsed === "object" ? parsed : {};
    const reply = replyFor(apiMethod, body as Record<string, unknown>);
    if (reply === null) return jsonResponse(200, { ok: false, error: "unknown_method" });
    return jsonResponse(200, { ok: true, ...reply });
  });

  const signedRequest = (body: string, delivery: SlackDeliveryOptions = {}): SignedRequest => {
    const ts = delivery.ts ?? Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", signingSecret).update(`v0:${ts}:${body}`).digest("hex");
    return {
      body,
      headers: new Headers({
        "x-slack-request-timestamp": String(ts),
        "x-slack-signature": `v0=${signature}`,
      }),
    };
  };

  const post = async (
    receiverUrl: string,
    body: string,
    contentType: string,
    delivery: SlackDeliveryOptions,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<SlackDeliveryResult> => {
    assertLoopbackUrl(receiverUrl);
    const signed = signedRequest(body, delivery);
    signed.headers.set("content-type", contentType);
    for (const [name, value] of Object.entries(extra)) signed.headers.set(name, value);
    const res = await fetch(receiverUrl, { method: "POST", headers: signed.headers, body });
    return { status: res.status, body: await res.text() };
  };

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    apiBaseUrl: `http://127.0.0.1:${server.port}/api`,
    signingSecret,
    calls: (method) =>
      recorded
        .filter((call) => method === undefined || call.apiMethod === method)
        .map(({ apiMethod: _apiMethod, ...call }) => call),
    signedRequest,
    deliverEvent: async (receiverUrl, payload, delivery = {}) => {
      const eventId = delivery.eventId ?? `Ev${randomBytes(6).toString("hex")}`;
      const ts = delivery.ts ?? Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T0FAKE",
        api_app_id: "A0FAKE",
        event_id: eventId,
        event_time: ts,
        event: payload,
      });
      const first = await post(receiverUrl, body, "application/json", { ts });
      if (delivery.replay !== true) return [first];
      const second = await post(
        receiverUrl,
        body,
        "application/json",
        { ts },
        {
          "x-slack-retry-num": "1",
          "x-slack-retry-reason": "http_timeout",
        },
      );
      return [first, second];
    },
    deliverInteraction: (receiverUrl, payload, delivery = {}) =>
      post(
        receiverUrl,
        new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
        "application/x-www-form-urlencoded",
        delivery,
      ),
    deliverCommand: (receiverUrl, fields, delivery = {}) =>
      post(
        receiverUrl,
        new URLSearchParams({ ...fields }).toString(),
        "application/x-www-form-urlencoded",
        delivery,
      ),
    stop: async () => {
      await server.stop();
    },
  };
}
