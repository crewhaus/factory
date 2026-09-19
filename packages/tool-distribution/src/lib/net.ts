/**
 * The download path for `PackageManifestVerify`, and the place the package's
 * central distinction is made: **a check that did not happen is not a check
 * that failed.**
 *
 * A package manifest is a bearer instruction to download and execute a binary.
 * Verifying one means fetching what it points at and hashing it, and that can
 * end in three genuinely different places:
 *
 *   - `missing`  — the server said 404/410. The asset is not there. Definite.
 *   - `ok`       — the bytes arrived complete and this is their sha256. The
 *                  caller compares it to what the manifest claims; a
 *                  disagreement is a definite mismatch.
 *   - `unknown`  — nothing was learned. DNS did not resolve, the deadline
 *                  elapsed, the caller cancelled, the body stopped short of
 *                  its own Content-Length, the cap was hit, the SSRF guard
 *                  refused the hop, the server answered 500. Every one of
 *                  these is a reason to look again, and none of them is
 *                  evidence about the asset.
 *
 * Collapsing the third into either of the first two is the defect this file
 * exists to prevent. Reporting "could not reach it" as a hash mismatch blocks
 * a good release; reporting it as verified ships an unverified one. So the
 * return type has three arms rather than a boolean, and `unknown` carries a
 * machine-readable `reason` as well as a sentence, because a caller that
 * decided by matching message text would break the first time someone reworded
 * one.
 *
 * MEMORY. An installer is tens of megabytes — the crewhaus binaries are ~80 MB
 * each — so the body is never held. Chunks go into an incremental sha256 and
 * are dropped; the only bound that matters is `maxBytes`, which stops a stream
 * that will not end. Hitting that cap is `unknown`/`cap`, NEVER a mismatch:
 * the hash of a prefix is a different number, and reporting it as a
 * disagreement would condemn a perfectly good release.
 *
 * SSRF. Every hop goes through `@crewhaus/tool-fetch`'s `assertNotSsrf` — the
 * same checker the Fetch tool uses, including the DNS-rebinding backstop — and
 * the connection is pinned to the address that was vetted, because resolving
 * in the guard and letting `fetch` re-resolve at connect time is a rebinding
 * TOCTOU. A release host that redirects to `http://169.254.169.254/` is the
 * attack, and a bare `fetch` would have followed it.
 */
import { createHash } from "node:crypto";
import { assertNotSsrf } from "@crewhaus/tool-fetch";

/** Release hosts redirect to CDNs and object stores; five hops is generous. */
export const MAX_REDIRECTS = 5;

/** 256 MiB. Nothing is retained, so this only stops a stream that never ends. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 900_000;

const USER_AGENT = "crewhaus-tool-distribution (+https://github.com/crewhaus/factory)";

/**
 * Why a probe learned nothing. Distinct values rather than one string because
 * they are different next moves: `dns` and `transport` say try again from
 * somewhere that can reach the host, `timeout` says raise the budget,
 * `cancelled` says the run was stopped and nothing is wrong with the release,
 * `cap` says raise `maxBytes`, `shortRead` says the transfer broke mid-flight,
 * `refused` says this package will not dial that address at all, `status` says
 * the server answered something that is neither the asset nor a 404, and
 * `unreadable` says a 200 arrived with no body to hash.
 */
export type UnknownReason =
  | "dns"
  | "timeout"
  | "cancelled"
  | "cap"
  | "shortRead"
  | "refused"
  | "transport"
  | "status"
  | "unreadable";

export type AssetProbe =
  | {
      readonly kind: "ok";
      readonly status: number;
      /** sha256 over every byte that arrived, lowercase hex. */
      readonly sha256: string;
      readonly bytes: number;
      readonly finalUrl: string;
    }
  | {
      readonly kind: "missing";
      readonly status: number;
      readonly finalUrl: string;
      readonly message: string;
    }
  | {
      readonly kind: "unknown";
      readonly reason: UnknownReason;
      readonly message: string;
      readonly status?: number;
      readonly bytes?: number;
      readonly finalUrl?: string;
    };

/**
 * The dialling step, as one function, so a test can replace all of it.
 *
 * All of it is the point: the SSRF check and the IP pin live BELOW this seam,
 * inside the default dialler, so a test that installs a stub never resolves a
 * name and never opens a socket. Every test in this package drives it.
 */
export type DistributionFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the `Host` header and
 * TLS SNI, so virtual hosting and certificate validation still work. Carried
 * over from `tool-fetch`'s own dialler rather than re-derived.
 */
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  if (pinnedIp === "" || unbracketed === pinnedIp) return globalThis.fetch(req);

  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const headers = new Headers(req.headers);
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);
  const init: RequestInit & { tls?: { serverName: string } } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    tls: { serverName: host },
  };
  return globalThis.fetch(pinnedUrl.toString(), init);
}

let distributionFetch: DistributionFetch = pinnedFetch;

/**
 * Test-only injection point, the convention every networked package here
 * follows. `undefined` restores the guarded dialler; a suite that sets it must
 * restore it, or the next file in the same bun process inherits the stub.
 */
export function _setFetch(fn: DistributionFetch | undefined): void {
  distributionFetch = fn ?? pinnedFetch;
}

export type ProbeOptions = {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

/**
 * GET one asset and hash it, following redirects by hand.
 *
 * Redirects are followed manually for two reasons the platform's `redirect:
 * "follow"` cannot give us: every hop is re-checked against the SSRF guard and
 * pinned to the address that was vetted, and every hop must still be https. A
 * manifest is a download-and-execute instruction, so a release host that
 * bounces the download onto plain http has stopped being verifiable — that is
 * a refusal, and a refusal is `unknown`, not a verdict about the asset.
 */
export async function probeAsset(rawUrl: string, options: ProbeOptions): Promise<AssetProbe> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return {
      kind: "unknown",
      reason: "refused",
      message: `"${rawUrl}" is not a URL this package can dial`,
    };
  }

  const deadline = startDeadline(options.timeoutMs, options.signal);
  try {
    for (let hop = 0; ; hop++) {
      if (current.protocol !== "https:") {
        return {
          kind: "unknown",
          reason: "refused",
          message: `refusing to fetch ${safeLabel(current)} over ${current.protocol.replace(":", "")} — an installer download is only verifiable over https`,
          finalUrl: current.toString(),
        };
      }

      let pinnedIp: string;
      try {
        pinnedIp = await assertNotSsrf(current.hostname);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // `assertNotSsrf` raises one error type for two different situations,
        // and they are different next moves: a name that did not resolve is a
        // resolver problem, a name that resolved into private space is a
        // refusal this package will never soften. Both are "nothing learned",
        // so the arm is the same and only the reason differs.
        const reason: UnknownReason = message.includes("cannot resolve") ? "dns" : "refused";
        return { kind: "unknown", reason, message, finalUrl: current.toString() };
      }

      let res: Response;
      try {
        res = await distributionFetch(
          new Request(current.toString(), {
            method: "GET",
            redirect: "manual",
            headers: new Headers({ "user-agent": USER_AGENT, accept: "*/*" }),
            signal: deadline.signal,
          }),
          pinnedIp,
        );
      } catch (err) {
        return transportFailure(err, current, deadline, options.signal);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        const location = res.headers.get("location") ?? "";
        await discard(res);
        if (hop >= MAX_REDIRECTS) {
          return {
            kind: "unknown",
            reason: "refused",
            message: `${safeLabel(current)} redirected more than ${MAX_REDIRECTS} times`,
            finalUrl: current.toString(),
          };
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return {
            kind: "unknown",
            reason: "refused",
            message: `${safeLabel(current)} redirected to an unparseable location "${location}"`,
            finalUrl: current.toString(),
          };
        }
        current = next;
        continue;
      }

      if (res.status === 404 || res.status === 410) {
        await discard(res);
        return {
          kind: "missing",
          status: res.status,
          finalUrl: current.toString(),
          message: `${safeLabel(current)} answered ${res.status} — the asset this manifest points at is not there`,
        };
      }

      if (res.status < 200 || res.status >= 300) {
        await discard(res);
        // Not a 404 and not the asset. A 403 can mean a private bucket, a 500
        // can mean the CDN is having a bad minute; neither is evidence that
        // the asset is missing, and treating a 403 as "missing" would fail a
        // release that is actually fine.
        return {
          kind: "unknown",
          reason: "status",
          status: res.status,
          message: `${`${safeLabel(current)} answered ${res.status} ${res.statusText}`.trimEnd()} — that is neither the asset nor a 404, so nothing was verified`,
          finalUrl: current.toString(),
        };
      }

      const declaredLength = contentLength(res);
      let hashed: { sha256: string; bytes: number } | { capped: true; bytes: number };
      try {
        hashed = await hashStream(res, options.maxBytes);
      } catch (err) {
        if (err instanceof UnreadableBody) {
          return {
            kind: "unknown",
            reason: "unreadable",
            status: res.status,
            finalUrl: current.toString(),
            message: `${safeLabel(current)} answered ${res.status} with ${err.message} — an empty asset and a dropped body look identical from here, so nothing was verified`,
          };
        }
        return transportFailure(err, current, deadline, options.signal);
      }

      if ("capped" in hashed) {
        return {
          kind: "unknown",
          reason: "cap",
          status: res.status,
          bytes: hashed.bytes,
          finalUrl: current.toString(),
          message: `${safeLabel(current)} is larger than the ${options.maxBytes}-byte cap — the read was stopped there, and a hash over a prefix is a different number, not a mismatch`,
        };
      }

      if (hashed.bytes === 0) {
        // A 200 that delivered nothing. `e3b0c442…` is the sha256 of no bytes
        // and it is a perfectly confident-looking answer, so this used to fall
        // through to the comparison and come back as a definite MISMATCH whose
        // message said "0 bytes were read in full, so this is a real
        // disagreement and not a failed download" — the exact claim the caller
        // must not believe. A release asset is never empty; a zero-byte 200 is
        // a dropped connection, a bad cache entry or a bucket serving a
        // placeholder, and none of those is evidence about the asset. Same
        // reasoning as the `body === null` arm, which this joins.
        return {
          kind: "unknown",
          reason: "unreadable",
          status: res.status,
          bytes: 0,
          finalUrl: current.toString(),
          message: `${safeLabel(current)} answered ${res.status} with an empty body — an asset that is genuinely zero bytes and a transfer that delivered nothing look identical from here, and the sha256 of no bytes is not evidence about this release`,
        };
      }

      if (declaredLength !== undefined && declaredLength !== hashed.bytes) {
        // The transfer ended early (or the server lied about the size). Either
        // way the bytes in hand are not the asset, so hashing them would
        // manufacture a mismatch out of a broken download.
        return {
          kind: "unknown",
          reason: "shortRead",
          status: res.status,
          bytes: hashed.bytes,
          finalUrl: current.toString(),
          message: `${safeLabel(current)} declared ${declaredLength} bytes and delivered ${hashed.bytes} — an incomplete body hashes to something that is not the asset`,
        };
      }

      return {
        kind: "ok",
        status: res.status,
        sha256: hashed.sha256,
        bytes: hashed.bytes,
        finalUrl: current.toString(),
      };
    }
  } finally {
    deadline.cancel();
  }
}

/**
 * An abort is either the caller cancelling the run or this package's own
 * deadline, and they are different things to tell somebody: one says the run
 * was stopped, the other says this host is too slow for the budget. Neither is
 * a verdict about the asset.
 */
function transportFailure(
  err: unknown,
  current: URL,
  deadline: Deadline,
  outer: AbortSignal | undefined,
): AssetProbe {
  const error = err as Error | undefined;
  if (error?.name === "AbortError" || deadline.signal.aborted) {
    if (outer?.aborted === true) {
      return {
        kind: "unknown",
        reason: "cancelled",
        message: `the caller cancelled this run before ${safeLabel(current)} was fetched`,
        finalUrl: current.toString(),
      };
    }
    return {
      kind: "unknown",
      reason: "timeout",
      message: `the deadline elapsed before ${safeLabel(current)} finished answering`,
      finalUrl: current.toString(),
    };
  }
  return {
    kind: "unknown",
    reason: "transport",
    message: `could not reach ${safeLabel(current)}: ${error?.message ?? String(err)}`,
    finalUrl: current.toString(),
  };
}

/**
 * The declared body size, when it is comparable to the bytes we will count.
 *
 * `Content-Length` describes the bytes ON THE WIRE. When the response is
 * content-encoded the runtime hands us the DECODED body, which is a different
 * (usually larger) number — so comparing the two would report a perfectly good
 * download as a short read. Rare for an installer, but "gzip on everything" is
 * a common CDN default, and a false `shortRead` on every asset would make this
 * tool useless exactly where it is needed.
 */
function contentLength(res: Response): number | undefined {
  const encoding = res.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
  const raw = res.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Hash a body as it arrives.
 *
 * The chunks are fed to the digest and dropped — nothing accumulates, so an
 * 80 MB installer costs one chunk of memory rather than 80 MB. The cap is a
 * guard against a stream that does not end; passing it stops the read and
 * reports how far it got, and the caller turns that into "could not check"
 * rather than into a verdict.
 *
 * `crypto.createHash` is used rather than `@crewhaus/tool-encode`'s `digest`
 * because that one is one-shot over a `Uint8Array` and hashing this way would
 * mean holding the whole installer. `lib.test.ts` pins this function's output
 * against tool-encode's `Hash` tool on a fixture, so the two cannot drift.
 */
async function hashStream(
  res: Response,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number } | { capped: true; bytes: number }> {
  if (res.body === null) {
    // A 200 with no body at all: this may be an empty asset or a body the
    // runtime dropped, and there is no way to tell which. Hashing "no bytes"
    // would answer e3b0c442… with total confidence about something we did not
    // read, so the caller is told the read did not happen.
    throw new UnreadableBody("the response carried no body to hash");
  }
  const reader = res.body.getReader();
  const digest = createHash("sha256");
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (total + value.byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already aborting; a failed cancel changes nothing.
        }
        return { capped: true, bytes: total + value.byteLength };
      }
      digest.update(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be released.
    }
  }
  return { sha256: digest.digest("hex"), bytes: total };
}

class UnreadableBody extends Error {
  override readonly name = "UnreadableBody";
}

/** Scheme, host and path — never the query, which can carry a token. */
export function safeLabel(url: URL | string): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed — nothing to release.
  }
}

export type Deadline = {
  readonly signal: AbortSignal;
  cancel(): void;
};

/**
 * A deadline that also honours the runtime's own cancellation. Always cancel
 * it in a `finally`, or a fast call leaves a timer holding the process open.
 */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`deadline of ${ms}ms elapsed`)), ms);
  const onOuter = (): void => ctrl.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/**
 * sha256 of bytes already in hand, lowercase hex. Used for the manifest files
 * themselves, which are kilobytes, not for downloads.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
