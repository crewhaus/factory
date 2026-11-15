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
 * | the inbound record cannot be written | 503, nothing claimed and no receipt, so the provider sends it again |
 * | the delivery id is claimed by a receipt that has settled, that is open while this ingress works on it, or that is open and another head's (recovery owns it) | 200 `{duplicate: true}`, nothing else |
 * | the delivery id is claimed by a receipt that never recorded it | 503: that receipt's claim is given up, so the provider's retry is accepted |
 * | the delivery id is claimed by an open receipt this head wrote and nothing here is working on | 503: that receipt is settled `failed` as never recorded and its claim is given up, so the provider's retry is accepted |
 * | otherwise | the receipt (`accepted`, actor `sys:ingress`, Home's ledger) holds the claim, its inbound record is on disk, then 200, then `handle` runs |
 *
 * The inbound record, `<hangarRoot>/ingress/<provider>/<digest>.json` (0600), is written
 * before the delivery id is claimed (`ingress/<provider>-<digest>`, in Home's command
 * ledger, with the receipt; the digest is the first 32 hex of the delivery id's sha256),
 * so a held claim always has a record while its receipt is open. An attempt that stops
 * between the record and the claim leaves the record unclaimed, and the provider's retry
 * reuses it. A delivery claim is never expired: every later delivery of that id is a
 * duplicate, however late. A claim is given up only by the receipt that holds it, and only
 * when that receipt never recorded its delivery: an open receipt of this head that nothing
 * here works on is first settled as never recorded, so a delivery whose receipt was written
 * but never worked on is handled on the provider's retry.
 *
 * The record keeps the raw body until the receipt settles, when it is removed. A crash
 * after the 200 leaves the receipt `accepted`: recovery settles an interrupted delivery
 * `unknown`, and the `inbound` sweep then drops its body ({@link sweepInboundRecords}).
 * `handle` is handed the delivery's `origin`, and the area that
 * owns the receiver classifies the text where it reaches a model: verifying a signature
 * says who sent it, never what it says.
 */
import { createHash } from "node:crypto";
import {
  type Stats,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TRUST_ORIGINS, type TrustOrigin } from "@crewhaus/boundary-classifier";
import {
  type CommandReceipt,
  RECEIPT_VIA,
  type ReceiptVia,
  isCommandKind,
} from "@crewhaus/control-contract";
import {
  expireClaimHeldBy,
  foldStates,
  readClaim,
  withLedgerLock,
} from "@crewhaus/control-records";
import {
  type ControlService,
  IDEMPOTENCY_TTL_MS,
  type Settlement,
  outcomeOf,
  receiptOf,
  workspaceCommandsLedger,
} from "@crewhaus/control-service";
import {
  DEFAULT_WEBHOOK_MAX_BYTES,
  readRequestBodyCapped,
} from "@crewhaus/gateway-protocol/body-limit";
import { json } from "./http";
import { resolveInside } from "./safety";

/** The effect a receipt carries when its delivery's inbound record could not be written. */
export const INBOUND_RECORD_EFFECT = "inbound-record";

/** Whether a receipt is one whose delivery was never recorded: its claim is not a delivery. */
function neverRecorded(receipt: CommandReceipt): boolean {
  return (
    receipt.state === "failed" &&
    receipt.effects.some(
      (effect) => effect.kind === INBOUND_RECORD_EFFECT && effect.status === "failed",
    )
  );
}

/** How a receipt whose delivery was never recorded settles: its claim is given up. */
const neverRecordedSettlement: Settlement = {
  state: "failed",
  outcome: outcomeOf("unavailable"),
  effects: [{ kind: INBOUND_RECORD_EFFECT, status: "failed" }],
};

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

/** A delivery's claim name: its provider and the first 32 hex of its delivery id's sha256. */
function deliveryClaim(provider: string, digest: string): string {
  return `ingress/${provider}-${digest}`;
}

/** The inbound record's place, by its real path inside the Hangar root. */
function inboundPath(hangarRoot: string, provider: string, digest: string): string | undefined {
  return resolveInside(hangarRoot, ["ingress", provider, `${digest}.json`]);
}

/** An inbound record's file name: a delivery digest. */
const INBOUND_FILE_RE = /^[0-9a-f]{32}\.json$/;

/** At most this many inbound records are looked at in one sweep; the rest are reported cut. */
const INBOUND_SWEEP_CAP = 10_000;

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

/** The entry at `path`, without following a link, or `undefined` when nothing is there. */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

export type InboundSweep = {
  /** Inbound records looked at. */
  readonly checked: number;
  readonly removed: number;
  /** True when there were more records than one sweep looks at. */
  readonly truncated: boolean;
};

/**
 * Remove the inbound records no receipt needs: a delivery's raw body is kept only while
 * its receipt is open. A record whose claim is held by a receipt in any state but
 * `accepted` or `running` is removed. A record with no claim, or whose claim is held by a
 * receipt that never recorded its delivery, is removed once it is older than the seven
 * days an idempotency key is honoured, and only while, under the ledger lock, its claim and
 * its file still read the same: an attempt about to claim it keeps it. A record whose
 * claim or receipt cannot be read is kept, with one warning per sweep.
 *
 * Only real directories named by the provider grammar, and only regular files named by a
 * delivery digest, are looked at; a link is never followed. The sweep never writes the
 * ledger and never removes or expires a claim.
 *
 * First consumer: Home's `inbound` sweep.
 */
export async function sweepInboundRecords(
  hangarRoot: string,
  now: number,
  warn: (message: string) => void,
): Promise<InboundSweep> {
  const none: InboundSweep = { checked: 0, removed: 0, truncated: false };
  const dir = resolveInside(hangarRoot, ["ingress"]);
  if (dir === undefined) return none;
  const top = lstatOrUndefined(dir);
  if (top === undefined || !top.isDirectory()) return none;
  const records: { provider: string; digest: string; path: string; mtimeMs: number }[] = [];
  let truncated = false;
  outer: for (const provider of readdirSync(dir).sort()) {
    if (!RECEIVER_PROVIDER_RE.test(provider)) continue;
    const providerDir = join(dir, provider);
    if (lstatOrUndefined(providerDir)?.isDirectory() !== true) continue;
    for (const name of readdirSync(providerDir).sort()) {
      if (!INBOUND_FILE_RE.test(name)) continue;
      const path = join(providerDir, name);
      const st = lstatOrUndefined(path);
      if (st === undefined || !st.isFile()) continue;
      if (records.length >= INBOUND_SWEEP_CAP) {
        truncated = true;
        break outer;
      }
      records.push({ provider, digest: name.slice(0, 32), path, mtimeMs: st.mtimeMs });
    }
  }
  if (records.length === 0) return { ...none, truncated };
  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  const ledger = workspaceCommandsLedger(hangarRoot);
  const fold = foldStates(ledger);
  if (!fold.ok) {
    warnOnce(`hangar-server: the inbound records were kept: ${fold.reason}`);
    return { checked: records.length, removed: 0, truncated };
  }
  const notBefore = now - IDEMPOTENCY_TTL_MS;
  let removed = 0;
  for (const record of records) {
    const claim = deliveryClaim(record.provider, record.digest);
    const read = readClaim(ledger, claim);
    let heldBy: string | undefined;
    if (read.ok) {
      const id = read.content.record["id"];
      const folded = typeof id === "string" ? fold.objects.get(id) : undefined;
      // A receipt not in the fold yet is one being written: its record stays.
      if (folded === undefined) continue;
      const receipt = receiptOf(folded.record);
      if (!neverRecorded(receipt)) {
        if (receipt.state === "accepted" || receipt.state === "running") continue;
        try {
          rmSync(record.path, { force: true });
          removed += 1;
        } catch (err) {
          warnOnce(
            `hangar-server: an inbound record was not removed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      // Held by a receipt that never recorded its delivery: the record may be a later
      // attempt's, so the age rule decides.
      heldBy = id as string;
    } else if (read.code !== "not-found") {
      warnOnce(`hangar-server: an inbound record was kept: ${read.reason}`);
      continue;
    }
    if (record.mtimeMs >= notBefore) continue;
    const answer = await withLedgerLock(ledger, () => {
      const again = readClaim(ledger, claim);
      const same = again.ok
        ? heldBy !== undefined && again.content.record["id"] === heldBy
        : heldBy === undefined && again.code === "not-found";
      if (!same) return false;
      const st = lstatOrUndefined(record.path);
      if (st === undefined || !st.isFile() || st.mtimeMs !== record.mtimeMs) return false;
      unlinkSync(record.path);
      return true;
    }).catch((err: unknown) => ({
      ok: false as const,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (answer === true) removed += 1;
    else if (answer !== false) {
      warnOnce(`hangar-server: an inbound record was kept: ${answer.reason}`);
    }
  }
  return { checked: records.length, removed, truncated };
}

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
  /**
   * The deliveries this ingress is recording, claiming or working on, by claim: an open
   * receipt of this head whose claim is not here has nothing working on it.
   */
  const inFlight = new Map<string, number>();
  const hold = (claim: string): void => {
    inFlight.set(claim, (inFlight.get(claim) ?? 0) + 1);
  };
  const letGo = (claim: string): void => {
    const left = (inFlight.get(claim) ?? 1) - 1;
    if (left > 0) inFlight.set(claim, left);
    else inFlight.delete(claim);
  };
  const maxBytes = deps.maxBytes ?? DEFAULT_WEBHOOK_MAX_BYTES;

  /** Drop a delivery's inbound record: nothing can need it again. */
  const dropRecord = (provider: string, digest: string): void => {
    try {
      const path = inboundPath(deps.hangarRoot, provider, digest);
      if (path !== undefined) rmSync(path, { force: true });
    } catch (err) {
      deps.onWarn(
        `hangar-server: a ${provider} inbound record was not removed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Make sure the delivery's inbound record is on disk: written whole (0600, exclusive),
   * or the one an earlier attempt of the same delivery left. Its mtime is set to this
   * ingress's clock, so the sweep's age rule reads the clock it was given. Throws when it
   * cannot.
   */
  const ensureRecord = (provider: string, digest: string, text: string): void => {
    mkdirSync(deps.hangarRoot, { recursive: true, mode: 0o700 });
    const dir = resolveInside(deps.hangarRoot, ["ingress", provider]);
    if (dir === undefined) throw new Error("the inbound records would leave Home's root");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = inboundPath(deps.hangarRoot, provider, digest);
    if (path === undefined) throw new Error("the inbound record would leave Home's root");
    try {
      writeFileSync(path, text, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      // Left by an earlier attempt of this delivery: reused, if it is a record at all.
      if (lstatOrUndefined(path)?.isFile() !== true) {
        throw new Error("the inbound record's place holds something else");
      }
    }
    const at = deps.now() / 1000;
    utimesSync(path, at, at);
  };

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
    if (!settled.ok) {
      // Left for recovery; the inbound sweep drops the body once its receipt ends.
      deps.onWarn(
        `hangar-server: a ${receiver.provider} delivery's receipt was not settled: ${settled.reason}`,
      );
      return;
    }
    dropRecord(receiver.provider, delivery.deliveryDigest);
  };

  /**
   * Give up a delivery's claim while `receiptId` holds it, so the provider's next attempt
   * is accepted. Called only with the id of a receipt that never recorded its delivery: a
   * claim any other receipt holds stays.
   */
  const release = async (claim: string, receiptId: string): Promise<void> => {
    try {
      const answer = await expireClaimHeldBy(deps.control.ledgers.workspace(), claim, receiptId);
      if (!answer.ok)
        deps.onWarn(`hangar-server: a delivery claim was not released: ${answer.reason}`);
    } catch (err) {
      deps.onWarn(
        `hangar-server: a delivery claim was not released: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      const claim = deliveryClaim(receiver.provider, digest);
      hold(claim);
      // Let go when this request answers, unless its work holds the claim until it settles.
      let held = true;
      const done = (): void => {
        if (!held) return;
        held = false;
        letGo(claim);
      };
      try {
        const notRecorded = () => json({ error: "the delivery could not be recorded" }, 503);
        const recordText = `${JSON.stringify({
          v: 1,
          provider: receiver.provider,
          receivedAt,
          deliveryDigest: digest,
          origin: receiver.origin,
          body: raw,
        })}\n`;
        const couldNotRecord = (err: unknown): void =>
          deps.onWarn(
            `hangar-server: a ${receiver.provider} delivery could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
          );
        // The raw body is on disk before the delivery id is claimed, so a held claim always
        // has its record while its receipt is open.
        try {
          ensureRecord(receiver.provider, digest, recordText);
        } catch (err) {
          couldNotRecord(err);
          return notRecorded();
        }
        const answer = await deps.control.commands
          .submit(
            {
              kind: receiver.kind,
              actor: "sys:ingress",
              ledger: "workspace",
              via: receiver.via,
              params: { provider: receiver.provider, delivery: digest },
              dedupeClaim: claim,
            },
            async (receipt) => {
              // The claim is this request's: its record is confirmed, or written again.
              try {
                ensureRecord(receiver.provider, digest, recordText);
              } catch (err) {
                couldNotRecord(err);
                return { settle: neverRecordedSettlement, value: undefined };
              }
              return { value: receipt };
            },
          )
          .catch(() => undefined);
        // Nothing was claimed: the record stays for the provider's retry.
        if (answer === undefined) return notRecorded();
        if (!answer.ok) {
          if (answer.refusal.code === "idempotency_key_reused") {
            return json({ duplicate: true }, 200);
          }
          return json({ error: answer.refusal.message }, 503);
        }
        if (answer.replayed) {
          // Another receipt holds the claim: this request works on nothing.
          done();
          const winner = answer.receipt;
          // The claim is held by a receipt that never recorded its delivery: give it up. The
          // record stays, for whichever attempt claims next.
          if (neverRecorded(winner)) {
            await release(claim, winner.id);
            return notRecorded();
          }
          // Open, and nothing in this ingress works on it: when this head wrote it, it is
          // settled as never recorded and its claim given up. Settle takes only this head's
          // own system receipt, so another head's open receipt stays a duplicate.
          if (winner.state === "accepted" && !inFlight.has(claim)) {
            const settled = await deps.control.commands.settle(
              "workspace",
              winner.id,
              neverRecordedSettlement,
            );
            if (settled.ok) {
              await release(claim, winner.id);
              return notRecorded();
            }
          }
          // Its claim is kept for good: once its receipt has ended, nothing needs the body.
          if (winner.state !== "accepted" && winner.state !== "running") {
            dropRecord(receiver.provider, digest);
          }
          return json({ duplicate: true }, 200);
        }
        if (answer.value === undefined) {
          await release(claim, answer.receipt.id);
          return notRecorded();
        }
        const receipt = answer.value;
        const delivery: IngressDelivery = {
          provider: receiver.provider,
          origin: receiver.origin,
          receivedAt,
          deliveryDigest: digest,
          headers: req.headers,
          body: raw,
          receipt,
        };
        // Acknowledged first: the work runs after the answer, and settles the receipt. The
        // claim stays held here until it has.
        held = false;
        const running = Promise.resolve()
          .then(() => work(receiver, delivery))
          .catch((err) =>
            deps.onWarn(
              `hangar-server: a ${receiver.provider} delivery could not be settled: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(() => letGo(claim));
        pending.add(running);
        void running.finally(() => pending.delete(running));
        return json({ ok: true, receipt: receipt.id }, 200);
      } finally {
        done();
      }
    },
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
