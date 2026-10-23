/**
 * `provability.sources.resolve: head` (design §6.1): is a cited URL there?
 *
 * One HEAD per distinct URL per session, through `@crewhaus/tool-fetch`'s
 * `guardedHead` — the Fetch tool's own guarded path: http(s) only, the
 * private-address classifier on every hop's literal and resolved address,
 * the socket pinned to the vetted IP, at most five redirects, the whole
 * request (DNS included) bounded. The spec's `sources.allow` / `sources.deny`
 * apply to the CITED URL — that is the source (§6.1); every redirect hop is
 * held to the private-host rule and `sources.deny`, so a cited page cannot
 * carry the check to a host the spec refused, while a `doi.org` citation can
 * still follow its redirect to the publisher an allow list does not name.
 * No body is read, so nothing enters the context and nothing needs
 * classifying.
 *
 * The answer is cached per session (bounded), the way design §6.1 asks: a
 * page cited on every turn of a long session is asked about once. Only
 * ANSWERS are cached — a status, or a refusal the guard will repeat (a
 * private or denied host, a URL that does not parse). A timeout, a network
 * failure or an unresolvable name says nothing lasting about the page: it
 * reads as "no answer" for this verification and is asked again on the next
 * one, so the gate's own retry can recover from a blip (and `on_fail: halt`
 * does not halt on one). An abort is the turn ending, not the page: it is
 * rethrown and forgotten.
 *
 * The request is an egress whose URL the model wrote, so each one decided
 * (sent, or refused by the guard) is recorded through `record` — the gate
 * turns it into an `egress_decision` on the run's audit sink (sink
 * `provability.resolve`, §10). A cache hit sends nothing and records
 * nothing. What is recorded is the host and the outcome, never the URL: its
 * path and query are model-written and may carry what an injection wanted
 * out.
 */
import type { IrProvability } from "@crewhaus/ir";
import { hostMatches, isPrivateHost } from "@crewhaus/provability";
import { FetchPermissionError, guardedHead } from "@crewhaus/tool-fetch";

/** How many (session, URL) answers one wiring remembers. */
export const HEAD_CACHE_ENTRIES = 1024;

/** The sink id a HEAD's `egress_decision` names (design §6.1). */
export const RESOLVE_SINK_ID = "provability.resolve";

/** One HEAD the guard decided on: what the gate records as an `egress_decision`. */
export type HeadDecision = {
  readonly sinkId: typeof RESOLVE_SINK_ID;
  readonly sinkScope: "external";
  /** `pass` — the request went out (whatever came back); `block` — the guard refused it. */
  readonly verdict: "pass" | "block";
  readonly method: "HEAD";
  /** The cited URL's host; absent when the URL did not parse. */
  readonly host?: string;
  /** The final status, when one came back. */
  readonly status?: number;
  /** Why there is no status: refused by the source / private-host policy, or the request failed. */
  readonly reason?: "refused" | "failed";
};

export type HeadResolver = (
  url: string,
  ctx: {
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
    /** Told about every request decided (never a cache hit); see the module doc. */
    readonly record?: (decision: HeadDecision) => void | Promise<void>;
  },
) => Promise<number | undefined>;

/** The spec's source policy as a host test: private hosts never, deny wins, an allow list admits only its hosts. */
export function sourceHostPolicy(sources: IrProvability["sources"]): (host: string) => boolean {
  return (raw) => {
    const host = raw.replace(/^\[/, "").replace(/\]$/, "");
    if (isPrivateHost(host)) return false;
    if (sources.deny.length > 0 && hostMatches(host, sources.deny)) return false;
    if (sources.allow.length > 0 && !hostMatches(host, sources.allow)) return false;
    return true;
  };
}

/**
 * The per-hop test for one request: the full policy on the cited URL, the
 * private-host rule and `deny` on every hop a redirect names. `guardedHead`
 * asks once per hop, in order, starting with the URL it was given.
 */
export function hopPolicy(sources: IrProvability["sources"]): (host: string) => boolean {
  const cited = sourceHostPolicy(sources);
  const redirected = sourceHostPolicy({ ...sources, allow: [] });
  let first = true;
  return (host) => {
    const ok = first ? cited(host) : redirected(host);
    first = false;
    return ok;
  };
}

/** Session-and-URL keyed answers; see {@link createHeadResolver}. */
export type HeadCache = Map<string, Promise<number | undefined>>;

/**
 * The guarded HEAD's answers for the whole process, shared by every wiring
 * that uses the default request: a channel bot wires its gates per turn, and
 * a per-wiring cache would ask again on every turn of a session. Keyed by
 * session, the source policy and the URL, so two specs in one process never
 * read each other's answers under different policies. Bounded like any
 * cache here ({@link HEAD_CACHE_ENTRIES}).
 */
export const SHARED_HEAD_CACHE: HeadCache = new Map();

/** A refusal the guard will make again for the same URL — an answer worth keeping. */
function isLastingRefusal(err: unknown): boolean {
  // An unresolvable name is reported as a refusal too, but DNS can come back.
  return err instanceof FetchPermissionError && !/cannot resolve/i.test(err.message);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

class Stopped extends Error {
  override readonly name = "Stopped";
}

/** `work`, or a rejection as soon as `signal` aborts — whatever `work` is waiting on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // Nobody waits on `work` any more; its own failure is not this turn's.
    work.catch(() => {});
    return Promise.reject(new Stopped("the turn was aborted"));
  }
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Stopped("the turn was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, stop]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * The cached resolver. `head` is the request itself — `guardedHead` in
 * production; a caller's `deps.resolveHead` (tests, a proxy-aware host)
 * replaces it and is cached, bounded by the turn's signal and recorded the
 * same way. `cache` is where answers are kept: a fresh one per resolver
 * unless the caller passes one to share.
 */
export function createHeadResolver(
  sources: IrProvability["sources"],
  head?: (url: string, signal?: AbortSignal) => Promise<number | undefined>,
  cache: HeadCache = new Map(),
): HeadResolver {
  const request =
    head ??
    ((url: string, signal?: AbortSignal) =>
      guardedHead(url, {
        allowHost: hopPolicy(sources),
        ...(signal !== undefined ? { signal } : {}),
      }));
  const policy = JSON.stringify([sources.allow, sources.deny]);
  return (url, ctx) => {
    const key = `${ctx.sessionId ?? ""}\u0000${policy}\u0000${url}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const host = hostOf(url);
    const record = async (decision: Omit<HeadDecision, "sinkId" | "sinkScope" | "method">) => {
      try {
        await ctx.record?.({
          sinkId: RESOLVE_SINK_ID,
          sinkScope: "external",
          method: "HEAD",
          ...(host !== undefined ? { host } : {}),
          ...decision,
        });
      } catch {
        // The audit trail is best-effort here, as on every egress path.
      }
    };
    const pending = (async (): Promise<number | undefined> => {
      try {
        const status = await untilAborted(request(url, ctx.signal), ctx.signal);
        const answer = typeof status === "number" && Number.isFinite(status) ? status : undefined;
        await record({
          verdict: "pass",
          ...(answer !== undefined ? { status: answer } : { reason: "failed" }),
        });
        if (answer === undefined) cache.delete(key);
        return answer;
      } catch (err) {
        // The turn ending is not an answer about the page: forget it.
        if (ctx.signal?.aborted === true) {
          cache.delete(key);
          throw err;
        }
        if (isLastingRefusal(err)) {
          await record({ verdict: "block", reason: "refused" });
        } else {
          await record({ verdict: "pass", reason: "failed" });
          cache.delete(key);
        }
        return undefined;
      }
    })();
    cache.set(key, pending);
    while (cache.size > HEAD_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return pending;
  };
}
