/**
 * A channel message, from the signed webhook to the session router: every message a
 * daemon accepts is on record before the platform is told `ok`.
 *
 * The emitted gateway authenticates the request (its capped read, `verify()` and
 * `parseInbound`) and hands the parsed event here. {@link handleInboundEvent} then
 * remembers its idempotency key (a duplicate answers `duplicate` and nothing more),
 * records the run that will answer it ({@link acceptInbound}), and only then answers
 * `ok`; the model turn runs off the request path, inside a scope that names that run.
 *
 * What is recorded: two content-free rows in the harness's run ledger,
 * `.crewhaus/run/control/runs/`, `queued` then `preparing`, for one fresh run id: the
 * state, when, what started it (`trigger: {kind: "channel", via?, source}`) and the
 * process holding it (`holder: {pid, host, startedAt}`). `source` names the platform and
 * holds keyed digests of the conversation, the message and an unlinked sender, or a
 * linked member's `prn_`: no text, no platform id. The runtime's own `running` row for
 * the same id follows when the turn starts. When the turn ends without the runtime
 * having written a row (the operator record refused it, or the router skipped it), the
 * run is closed `cancelled {reason: "not-admitted"}`, or `failed {failureClass:
 * "not-started"}` when it threw. A daemon that dies first leaves a `preparing` row the
 * control plane's recovery closes `interrupted {reason: "not-processed"}`.
 *
 * `CREWHAUS_RUN_LEDGER=0` writes no row, as it does for the runtime's run rows. A row
 * that cannot be written still accepts the message, with one stderr line: refusing would
 * make the platform retry into a dedupe store that already holds the key.
 *
 * Inbound text is still classified at `channel` where the agent's turn reads it
 * (`classifyInbound`); nothing here reads the text.
 */
import { hostname } from "node:os";
import { type Trigger, type TriggerSource, mintRunId } from "@crewhaus/control-contract";
import {
  type ApproverRead,
  CHANNEL_CONVERSATION_LABEL,
  CHANNEL_MESSAGE_LABEL,
  CHANNEL_SENDER_LABEL,
  type DigestKeyRead,
  appendPreparingRun,
  ensureDigestKey,
  keyedDigest,
  readApproverProjection,
  runsLedger,
  settleUnstartedRun,
} from "@crewhaus/control-records";
import { runWithScope } from "@crewhaus/run-context";

/** The fields of a parsed inbound event this module reads. */
export type InboundEventLike = {
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly threadTs?: string;
  readonly ts: string;
};

/** The replay-dedupe store: `@crewhaus/durable-state`'s `DedupStore` satisfies it. */
export type InboundDedup = {
  /** `true` when the key was already remembered. */
  remember(key: string): Promise<boolean>;
};

export type AcceptInboundOptions = {
  /** The harness whose run ledger records the message; default the working directory. */
  readonly harnessDir?: string;
  /** The approver projection reader, for a linked sender; the default caches for one second. */
  readonly approvers?: (harnessDir: string) => ApproverRead;
  /** The harness's digest key; default `ensureDigestKey` (tests hold it). */
  readonly digestKey?: (harnessDir: string) => Promise<DigestKeyRead>;
  readonly now?: () => number;
};

export type AcceptedInbound = {
  /** The run that answers the message. */
  readonly runId: string;
  /**
   * Run `fn` (the router's handling) inside a scope that names the run: its first
   * context takes `runId` and `trigger`. When `fn` settles and the run's newest row is
   * still `preparing`, the run is closed: `cancelled` when it returned, `failed` when it
   * threw (and the throw goes on).
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
};

/** What a ref on a run row may look like; anything else is left out. */
const REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function ref(value: string | undefined): string | undefined {
  return value !== undefined && REF_RE.test(value) ? value : undefined;
}

/** When this process started, from its own clock. */
function startedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** The linked member a Slack sender is, by the projection's links, if any. */
function linkedSender(read: ApproverRead, subject: string | undefined): string | undefined {
  if (subject === undefined || read.state !== "present") return undefined;
  return read.projection.links.find((link) => link.external === subject)?.principal;
}

async function sourceOf(
  event: InboundEventLike,
  platform: string,
  harnessDir: string,
  opts: AcceptInboundOptions,
): Promise<TriggerSource | undefined> {
  let key: DigestKeyRead;
  try {
    key = await (opts.digestKey ?? ensureDigestKey)(harnessDir);
  } catch {
    return undefined;
  }
  if (key.state !== "present") return undefined;
  const conversationRef = ref(
    await keyedDigest(key.hmac, CHANNEL_CONVERSATION_LABEL, [
      platform,
      event.workspaceId,
      event.channelId,
      event.threadTs ?? event.ts,
    ]),
  );
  const messageRef = ref(
    await keyedDigest(key.hmac, CHANNEL_MESSAGE_LABEL, [platform, event.idempotencyKey]),
  );
  if (conversationRef === undefined || messageRef === undefined) return undefined;
  let read: ApproverRead;
  try {
    read = (opts.approvers ?? readApproverProjection)(harnessDir);
  } catch {
    read = { state: "absent" };
  }
  const subject = platform === "slack" ? `slack:${event.workspaceId}:${event.userId}` : undefined;
  const senderRef = ref(
    linkedSender(read, subject) ??
      (await keyedDigest(key.hmac, CHANNEL_SENDER_LABEL, [
        platform,
        event.workspaceId,
        event.userId,
      ])),
  );
  return {
    platform,
    conversationRef,
    messageRef,
    ...(senderRef !== undefined ? { senderRef } : {}),
  };
}

/**
 * Record the run that will answer an accepted message: `queued`, then `preparing`, in
 * the harness's run ledger, under a fresh run id. Resolves once both rows are written
 * (or could not be), which is what the platform's `ok` waits on.
 */
export async function acceptInbound(
  event: InboundEventLike,
  adapter: { readonly id: string },
  opts: AcceptInboundOptions = {},
): Promise<AcceptedInbound> {
  const runId = mintRunId();
  const harnessDir = opts.harnessDir ?? process.cwd();
  const now = opts.now ?? (() => Date.now());
  const off = process.env["CREWHAUS_RUN_LEDGER"] === "0";
  const source = off ? undefined : await sourceOf(event, adapter.id, harnessDir, opts);
  const trigger: Trigger = {
    kind: "channel",
    ...(adapter.id === "slack" ? { via: "slack" as const } : {}),
    ...(source !== undefined ? { source } : {}),
  };
  const ledger = runsLedger(harnessDir);
  let recorded = false;
  if (!off) {
    const written = appendPreparingRun(ledger, {
      id: runId,
      at: new Date(now()).toISOString(),
      trigger,
      holder: { pid: process.pid, host: hostname(), startedAt: startedAt() },
    });
    if (written.ok) recorded = true;
    else process.stderr.write(`[gateway] run not recorded: ${written.code}\n`);
  }
  const settle = async (threw: boolean): Promise<void> => {
    if (!recorded) return;
    const at = new Date(now()).toISOString();
    try {
      const settled = await settleUnstartedRun(
        ledger,
        runId,
        threw
          ? { state: "failed", at, fields: { failureClass: "not-started" } }
          : { state: "cancelled", at, fields: { reason: "not-admitted" } },
      );
      if (!settled.ok) process.stderr.write(`[gateway] run not settled: ${settled.code}\n`);
    } catch (err) {
      process.stderr.write(`[gateway] run not settled: ${(err as Error).message}\n`);
    }
  };
  return {
    runId,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      let value: T;
      try {
        value = await runWithScope({ runId, trigger }, fn);
      } catch (err) {
        await settle(true);
        throw err;
      }
      await settle(false);
      return value;
    },
  };
}

/**
 * The gateway's events route after an event parsed: dedupe, record, answer. The router's
 * handling runs in one microtask after the answer, its error one stderr line.
 */
export async function handleInboundEvent<
  E extends InboundEventLike,
  A extends { readonly id: string },
>(
  event: E,
  adapter: A,
  deps: AcceptInboundOptions & {
    readonly dedup: InboundDedup;
    readonly sessionRouter: { handle(event: E, adapter: A): Promise<void> };
  },
): Promise<Response> {
  const seen = await deps.dedup.remember(event.idempotencyKey);
  if (seen) return new Response("duplicate", { status: 200 });
  const accepted = await acceptInbound(event, adapter, deps);
  // Slack expects an answer within 3 s (Telegram, Discord and WhatsApp have similar
  // windows), so the model turn runs off the request path; the adapter's own outbound
  // delivers the reply when the turn finishes.
  queueMicrotask(() => {
    accepted
      .run(() => deps.sessionRouter.handle(event, adapter))
      .catch((err) => {
        process.stderr.write(
          `[gateway] handler error (${event.idempotencyKey}): ${(err as Error).message}\n`,
        );
      });
  });
  return new Response("ok", { status: 200 });
}
