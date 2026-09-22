/**
 * Turning one lookup into one verdict about one peer.
 *
 * THE POINT OF THIS FILE. A peer that answered and is healthy, a peer that
 * answered and is not, and a peer that DID NOT ANSWER are three results, not
 * two. `@crewhaus/federation-discovery` gives a caller two — a `PeerRecord`,
 * or a `FederationDiscoveryError` that covers a refused connection, a 503, a
 * body that is not JSON and a fingerprint that is the wrong length with the
 * same throw. Collapsing those into "not in the federation" makes a federation
 * look smaller than it is; collapsing them into "present" makes it look
 * healthier. Either way somebody pages the wrong team.
 *
 * So the verdict is decided from the ATTEMPT RECORD — a value written at the
 * moment the socket did or did not produce bytes (see `./net`) — and not from
 * the text of the error that came out of the library. A library is free to
 * reword its messages; a tool that greps them turns a reword into a wrong
 * answer about production.
 *
 * Five outcomes, and the difference between them is what somebody does next:
 *
 *   healthy       answered, and everything asserted about the answer held.
 *   unhealthy     answered, and something about the answer is wrong. The peer
 *                 is up. Read the reason.
 *   unreachable   no answer. The peer may be fine and the path may be broken;
 *                 what is known is that nothing came back.
 *   refused       this tool did not ask. A guard stopped it, or the peer id is
 *                 not one the library will resolve. Nothing at all is known
 *                 about the peer, and it must not be counted as down.
 *   undetermined  the question was cut off for a reason that is about US — the
 *                 run was cancelled, or the sweep's own deadline elapsed before
 *                 this peer's turn. Also not down.
 *
 * WHAT "HEALTHY" DOES NOT MEAN. No federation call is made. A peer is healthy
 * here when it serves a `.well-known/crewhaus.json` that the discovery library
 * parses into a record and that record satisfies what the caller pinned. A
 * peer that passes can still refuse every real request.
 */
import type { PeerRecord } from "@crewhaus/federation-discovery";
import type { Attempt, Vetted } from "./net";
import { CAPS, quoteUntrusted } from "./untrusted";

export type PeerOutcome = "healthy" | "unhealthy" | "unreachable" | "refused" | "undetermined";

export type PeerVerdict = {
  readonly outcome: PeerOutcome;
  /** Machine-readable, stable, and the thing to branch on. */
  readonly code: string;
  /** One sentence naming what happened. Safe to print: authored text is quoted. */
  readonly reason: string;
};

/** What the caller asserted about this peer before the lookup ran. */
export type Expectations = {
  /** SHA-256 fingerprint, already normalised by {@link normalizeFingerprint}. */
  readonly pin?: string;
  /** Exact federation protocol version this fleet expects. */
  readonly version?: string;
};

/**
 * A caller-supplied fingerprint, in the one form a comparison may use.
 *
 * Operators copy fingerprints out of `openssl`, which prints them
 * `AA:BB:CC:…`, out of a dashboard, which prints them upper-case, and out of a
 * config file, which may have wrapped them. The discovery library stores the
 * peer's own fingerprint lower-case and separator-free, so the caller's copy is
 * brought to that same form ONCE, here, and every comparison downstream is
 * between two values in the same representation.
 *
 * Getting this wrong is worse than not pinning at all: a formatting difference
 * reported as a fingerprint change is an alert that teaches operators to click
 * through the real one. Returns `null` when the input is not a SHA-256
 * fingerprint at all, which is a refusal to check rather than a check that
 * passes.
 */
export function normalizeFingerprint(raw: string): string | null {
  const stripped = raw.replace(/[\s:-]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(stripped) ? stripped : null;
}

/**
 * The library's error text, quoted.
 *
 * It reads like the tool's own words but is not: `parsePeerRecord` interpolates
 * the peer's `endpoint` into `(got …)`, so a peer that answers with a hostile
 * `endpoint` string gets that string echoed into a message a model reads.
 */
function quoteLibrary(message: string): string {
  return quoteUntrusted(message, CAPS.description).text;
}

/**
 * Verdicts on the ADVERTISED endpoint that are the PEER's fault.
 *
 * Deliberately not the whole set. `unresolvable` means this resolver could not
 * answer, which is a fact about here, not there; and `not-allow-listed` means
 * the operator of THIS process has not permitted that origin, which is a
 * policy fact about this process — an operator who allow-lists only the hosts
 * they discover from would otherwise see every peer in a healthy federation
 * reported unhealthy. Both are recorded under `unknowns` instead, which is the
 * honest place for "this was not established".
 */
const UNHEALTHY_ENDPOINT_CODES: ReadonlySet<string> = new Set([
  "private",
  "scheme",
  "userinfo",
  "not-a-url",
]);

export type ClassifyInput = {
  /** What the socket did, when one was attempted. */
  readonly attempt?: Attempt;
  /** True when the discovery library answered from its own TTL cache. */
  readonly fromCache: boolean;
  /** The record, when the lookup produced one. */
  readonly record?: PeerRecord;
  /** The library's error, when it did not. */
  readonly error?: string;
  /** The verdict on the endpoint the peer ADVERTISED, when one was reached. */
  readonly endpointVet?: Vetted;
  readonly expect: Expectations;
};

export function classifyPeer(input: ClassifyInput): PeerVerdict {
  const { attempt, record, fromCache } = input;

  if (record === undefined) {
    // No record. Which of the four not-healthy answers it is comes from the
    // attempt record, in this order, because each earlier kind means strictly
    // less was learned than the next.
    if (attempt?.kind === "refused") {
      return {
        outcome: "refused",
        code: `refused:${attempt.code}`,
        reason: attempt.reason,
      };
    }
    if (attempt?.kind === "no-answer") {
      if (attempt.code === "cancelled") {
        return { outcome: "undetermined", code: "undetermined:cancelled", reason: attempt.reason };
      }
      return {
        outcome: "unreachable",
        code: `unreachable:${attempt.code}`,
        reason: attempt.reason,
      };
    }
    if (attempt?.kind === "answered") {
      // Bytes came back. The peer is UP; its answer is the problem.
      if (attempt.location !== undefined) {
        return {
          outcome: "unhealthy",
          code: `unhealthy:redirect-${attempt.status}`,
          reason: `answered HTTP ${attempt.status} with a redirect to "${quoteUntrusted(attempt.location, CAPS.url).text}", which this tool does not follow — the target would go through none of the checks the peer id did`,
        };
      }
      if (attempt.status !== 200) {
        return {
          outcome: "unhealthy",
          code: `unhealthy:http-${attempt.status}`,
          reason: `answered HTTP ${attempt.status} for its .well-known/crewhaus.json`,
        };
      }
      if (attempt.truncated) {
        return {
          outcome: "unhealthy",
          code: "unhealthy:body-too-large",
          reason: `answered HTTP 200 but its .well-known/crewhaus.json is larger than the ${attempt.bytes} bytes read before the cap, so it was not parsed`,
        };
      }
      return {
        outcome: "unhealthy",
        code: "unhealthy:bad-record",
        reason: `answered HTTP 200 but its .well-known/crewhaus.json is not a peer record: ${quoteLibrary(input.error ?? "no reason given")}`,
      };
    }
    // No attempt at all. Either the library answered from its negative cache
    // without dialling, or it refused the peer id before there was anything to
    // dial. `fromCache` is read from the library's own cache state rather than
    // guessed from the message, which is how those two stay apart.
    if (fromCache) {
      return {
        outcome: "unreachable",
        code: "unreachable:cached",
        reason: `a lookup within the discovery cache's negative TTL already failed, and was not repeated: ${quoteLibrary(input.error ?? "no reason given")}`,
      };
    }
    return {
      outcome: "refused",
      code: "refused:peer-id",
      reason: `the peer id was not resolved and no request was made: ${quoteLibrary(input.error ?? "no reason given")}`,
    };
  }

  // A record came back. It is still only healthy if it is the record the
  // caller asked for, and if the address it advertises is one anything should
  // dial.
  const { pin, version } = input.expect;
  if (pin !== undefined && record.publicKeyFingerprint !== pin) {
    return {
      outcome: "unhealthy",
      code: "unhealthy:fingerprint-mismatch",
      reason: `answered, but its public-key fingerprint is ${record.publicKeyFingerprint}, not the pinned ${pin}`,
    };
  }
  if (version !== undefined && record.version !== version) {
    return {
      outcome: "unhealthy",
      code: "unhealthy:version-mismatch",
      reason: `answered, but it reports federation version "${quoteUntrusted(record.version, CAPS.version).text}", not the required "${quoteUntrusted(version, CAPS.version).text}"`,
    };
  }
  const vet = input.endpointVet;
  if (vet !== undefined && !vet.ok && UNHEALTHY_ENDPOINT_CODES.has(vet.code)) {
    // The peer answered from a public name and then pointed somewhere else.
    // Whatever federates with it next dials THIS address, and it went through
    // none of the checks the peer id did — so it is the peer's answer that is
    // wrong, and the tool says so instead of passing the address along clean.
    return {
      outcome: "unhealthy",
      code: `unhealthy:endpoint-${vet.code}`,
      reason: `answered, but the endpoint it advertises would not be dialled: ${vet.reason}`,
    };
  }
  return {
    outcome: "healthy",
    code: fromCache ? "healthy:cached" : "healthy",
    reason: fromCache
      ? "resolved from the discovery cache within its TTL; no request was made on this call"
      : "answered with a well-formed peer record",
  };
}

/** The tally a fleet sweep reports. Every outcome has its own column. */
export function tally(verdicts: ReadonlyArray<PeerVerdict>): Record<PeerOutcome | "total", number> {
  const counts: Record<PeerOutcome | "total", number> = {
    healthy: 0,
    unhealthy: 0,
    unreachable: 0,
    refused: 0,
    undetermined: 0,
    total: verdicts.length,
  };
  for (const v of verdicts) counts[v.outcome] += 1;
  return counts;
}
