/**
 * Home's receivers: the places a third party delivers to (a chat app's events, a code
 * host's webhooks), answered on a listener of their own at `/hooks/<provider>/…`, never on
 * the console's.
 *
 * A receiver declares where its text comes from (a `TrustOrigin`), the door its receipts
 * name (`via`), the receipt kind it writes, and three functions: `verify` (the request is
 * the provider's, by its signature), `dedupeRef` (the provider's delivery id) and `handle`
 * (the work, settled as a receipt). A delivery is answered in this order:
 *
 * | Step | Answer |
 * |---|---|
 * | the body is over the limit | 413, nothing written |
 * | `verify` says no | 401, nothing written |
 * | no delivery id | 400, nothing written |
 * | the delivery id was claimed before | 200 `{duplicate: true}`, nothing else |
 * | otherwise | the receipt (`accepted`, actor `sys:ingress`, Home's ledger) and the inbound record are durable, then 200, then `handle` runs |
 *
 * The delivery id is claimed exactly once (`ingress/<provider>-<first 32 hex of its
 * sha256>`, in Home's command ledger, with the receipt). The inbound record,
 * `<hangarRoot>/ingress/<provider>/<cmd_ id>.json` (0600), keeps the raw body until the
 * receipt settles, when it is removed; a crash after the 200 leaves the receipt
 * `accepted` for recovery. `handle` is handed the delivery's `origin`, and the area that
 * owns the receiver classifies the text where it reaches a model: verifying a signature
 * says who sent it, never what it says.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { TRUST_ORIGINS, type TrustOrigin } from "@crewhaus/boundary-classifier";
import {
  type CommandReceipt,
  RECEIPT_VIA,
  type ReceiptVia,
  isCommandKind,
} from "@crewhaus/control-contract";
import { type ControlService, type Settlement, outcomeOf } from "@crewhaus/control-service";
import {
  DEFAULT_WEBHOOK_MAX_BYTES,
  readRequestBodyCapped,
} from "@crewhaus/gateway-protocol/body-limit";
import { json } from "./http";
import { resolveInside } from "./safety";

/** A receiver's provider name: it names a claim and a directory. */
export const RECEIVER_PROVIDER_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** One verified delivery, as a receiver's `handle` is given it. */
export type IngressDelivery = {
  readonly provider: string;
  /** Where its text comes from: classify it as this before it reaches a model. */
  readonly origin: TrustOrigin;
  readonly receivedAt: string;
  /** The first 32 hex of the delivery id's sha256: what was claimed. */
  readonly deliveryDigest: string;
  readonly headers: Headers;
  /** The raw body, exactly as it was signed. */
  readonly body: string;
  readonly receipt: CommandReceipt;
};

export type ReceiverContext = { readonly now: () => number };

export type Receiver = {
  readonly provider: string;
  readonly via: ReceiptVia;
  /** The receipt kind a delivery writes: a command kind, or `legacy.<key>`. */
  readonly kind: string;
  readonly origin: TrustOrigin;
  verify(req: Request, raw: string): boolean | Promise<boolean>;
  /** The provider's delivery id; `undefined` refuses the delivery. */
  dedupeRef(req: Request, raw: string): string | undefined;
  handle(delivery: IngressDelivery, ctx: ReceiverContext): Promise<Settlement>;
};

/**
 * What is wrong with a set of receivers, one line per problem: a provider named twice or
 * not of the provider grammar, an origin that is not a `TrustOrigin`, a `via` that is not
 * a receipt door, a kind that is not a receipt kind.
 */
export function receiverProblems(
  receivers: ReadonlyArray<{ readonly area: string; readonly receiver: Receiver }>,
): readonly string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const { area, receiver } of receivers) {
    const name = JSON.stringify(receiver.provider);
    if (typeof receiver.provider !== "string" || !RECEIVER_PROVIDER_RE.test(receiver.provider)) {
      problems.push(`receiver provider ${name} is not a provider name (area "${area}")`);
    }
    const first = seen.get(receiver.provider);
    if (first !== undefined) {
      problems.push(`receiver ${name} registered twice (areas "${first}" and "${area}")`);
    } else {
      seen.set(receiver.provider, area);
    }
    if (!(TRUST_ORIGINS as readonly string[]).includes(receiver.origin)) {
      problems.push(
        `receiver ${name} declares origin ${JSON.stringify(receiver.origin)}, which is not a TrustOrigin (area "${area}")`,
      );
    }
    if (!(RECEIPT_VIA as readonly string[]).includes(receiver.via)) {
      problems.push(
        `receiver ${name} declares via ${JSON.stringify(receiver.via)}, which is not a receipt door (area "${area}")`,
      );
    }
    if (!isCommandKind(receiver.kind)) {
      problems.push(
        `receiver ${name} declares kind ${JSON.stringify(receiver.kind)}, which is not a receipt kind (area "${area}")`,
      );
    }
  }
  return problems;
}

/** sha256 as lower-case hex. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hexBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether `signature` (hex) is the HMAC-SHA256 of `payload` under `secret`, by WebCrypto,
 * compared in constant time over the whole digest. A signature that is not hex of the
 * digest's length is no.
 *
 * First consumers: Home's receivers, from the integrations area.
 */
export async function verifyHmacSha256(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const given = hexBytes(signature.trim());
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  if (given === undefined || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= (expected[i] ?? 0) ^ (given[i] ?? 0);
  return diff === 0;
}

export type Ingress = {
  /** Answer a request on the ingress listener. */
  fetch(req: Request): Promise<Response>;
  /** Resolves once every `handle` already started has settled its receipt. */
  idle(): Promise<void>;
};

export function createIngress(deps: {
  readonly hangarRoot: string;
  readonly receivers: readonly Receiver[];
  readonly control: ControlService;
  readonly now: () => number;
  readonly onWarn: (message: string) => void;
  readonly maxBytes?: number;
}): Ingress {
  const byProvider = new Map(deps.receivers.map((receiver) => [receiver.provider, receiver]));
  const pending = new Set<Promise<void>>();
  const maxBytes = deps.maxBytes ?? DEFAULT_WEBHOOK_MAX_BYTES;

  /** The inbound record's place, by its real path inside the Hangar root. */
  const inboundPath = (provider: string, id: string): string | undefined =>
    resolveInside(deps.hangarRoot, ["ingress", provider, `${id}.json`]);

  const work = async (receiver: Receiver, delivery: IngressDelivery): Promise<void> => {
    let settlement: Settlement;
    try {
      settlement = await receiver.handle(delivery, { now: deps.now });
    } catch (err) {
      deps.onWarn(
        `hangar-server: the ${receiver.provider} receiver failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      settlement = { state: "failed", outcome: outcomeOf("internal") };
    }
    const settled = await deps.control.commands.settle(
      "workspace",
      delivery.receipt.id,
      settlement,
    );
    if (settled !== undefined) {
      const path = inboundPath(receiver.provider, delivery.receipt.id);
      if (path !== undefined) rmSync(path, { force: true });
    }
  };

  return {
    fetch: async (req) => {
      const url = new URL(req.url);
      const segments = url.pathname.split("/").filter((s) => s !== "");
      if (segments[0] !== "hooks" || segments[1] === undefined) {
        return json({ error: "not found" }, 404);
      }
      const receiver = byProvider.get(segments[1]);
      if (receiver === undefined) return json({ error: "not found" }, 404);
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const read = await readRequestBodyCapped(req, maxBytes);
      if (!read.ok) return read.response;
      const raw = read.text;
      let verified = false;
      try {
        verified = (await receiver.verify(req, raw)) === true;
      } catch {
        verified = false;
      }
      if (!verified) return json({ error: "not verified" }, 401);
      const ref = receiver.dedupeRef(req, raw);
      if (typeof ref !== "string" || ref === "") {
        return json({ error: "no delivery id" }, 400);
      }
      const digest = sha256Hex(ref).slice(0, 32);
      const receivedAt = new Date(deps.now()).toISOString();
      const answer = await deps.control.commands
        .submit(
          {
            kind: receiver.kind,
            actor: "sys:ingress",
            ledger: "workspace",
            via: receiver.via,
            params: { provider: receiver.provider, delivery: digest },
            dedupeClaim: `ingress/${receiver.provider}-${digest}`,
          },
          async (receipt) => {
            // The raw body is kept until the receipt settles, so recovery has the delivery.
            mkdirSync(deps.hangarRoot, { recursive: true, mode: 0o700 });
            const dir = resolveInside(deps.hangarRoot, ["ingress", receiver.provider]);
            if (dir === undefined) throw new Error("the inbound records would leave Home's root");
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const path = inboundPath(receiver.provider, receipt.id);
            if (path === undefined) throw new Error("the inbound record would leave Home's root");
            writeFileSync(
              path,
              `${JSON.stringify({
                v: 1,
                provider: receiver.provider,
                receivedAt,
                deliveryDigest: digest,
                origin: receiver.origin,
                body: raw,
              })}\n`,
              { mode: 0o600, flag: "wx" },
            );
            return { value: receipt };
          },
        )
        .catch(() => undefined);
      if (answer === undefined) return json({ error: "the delivery could not be recorded" }, 503);
      if (!answer.ok) {
        if (answer.refusal.code === "idempotency_key_reused") {
          return json({ duplicate: true }, 200);
        }
        return json({ error: answer.refusal.message }, 503);
      }
      if (answer.replayed) return json({ duplicate: true }, 200);
      const receipt = answer.value ?? answer.receipt;
      const delivery: IngressDelivery = {
        provider: receiver.provider,
        origin: receiver.origin,
        receivedAt,
        deliveryDigest: digest,
        headers: req.headers,
        body: raw,
        receipt,
      };
      // Acknowledged first: the work runs after the answer, and settles the receipt.
      const running = Promise.resolve()
        .then(() => work(receiver, delivery))
        .catch((err) =>
          deps.onWarn(
            `hangar-server: a ${receiver.provider} delivery could not be settled: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      pending.add(running);
      void running.finally(() => pending.delete(running));
      return json({ ok: true, receipt: receipt.id }, 200);
    },
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
