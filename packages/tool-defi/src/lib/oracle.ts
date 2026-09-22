import {
  MAX_CONTRACT_TEXT_CHARS,
  SELECTORS,
  asSigned,
  callNoArgs,
  callWithBytes32,
  decodeString,
  decodeWords,
  normalizeAddress,
  normalizeBytes32,
  sanitizeContractText,
} from "./abi";
/**
 * Reading a price feed onchain, and saying what its own freshness signal says.
 *
 * THE POINT OF THIS FILE: "stale" is not one thing, and collapsing the two
 * things it means is how a wrong oracle verdict ships.
 *
 *   - **A Chainlink aggregator updates on heartbeat OR deviation.** A feed
 *     whose price has not moved legitimately looks old — an hour past a
 *     one-hour heartbeat is routine, not a halt. The signal that a round is
 *     genuinely incomplete is `answeredInRound < roundId`, which is a fact
 *     about the round rather than a fact about the clock. Checking only age
 *     produces false halts; checking only round completeness misses a feed
 *     that is frozen with a complete round behind it. So both are reported,
 *     under their own names, and the heartbeat comparison only happens when
 *     the caller supplies the heartbeat — it is a property of the feed's
 *     deployment, not something the aggregator will tell you, and a tool that
 *     guessed one would be inventing the threshold it then judges against.
 *
 *   - **Pyth's freshness is a confidence interval over the price**, which is a
 *     different quantity in different units with a different failure mode. A
 *     Pyth price two seconds old with a confidence band 400 bps wide is worse
 *     than one a minute old with a band of 3 bps, and no single boolean can
 *     say that.
 *
 * So there is no `stale` field anywhere in this package. Each feed reports its
 * own signal under its own name, and the caller decides.
 */
import { type BatchCall, type CallOutcome, batchCalls } from "./batch";
import { type Fixed, fixed, isPositive, ratioBps, toDecimalString, trim } from "./decimal";
import { DefiError, type RpcOptions, endpointLabel, nowSeconds } from "./rpc";

/** Chainlink and Pyth. Everything else is refused by name rather than guessed at. */
export type OracleKind = "chainlink" | "pyth";

export type OracleProvenance = {
  readonly source: OracleKind;
  readonly chainId: string;
  /** Scheme and host only — an RPC URL's path routinely carries an API key. */
  readonly endpoint: string;
  readonly contract: string;
  readonly blockTag: string;
  /** How the number was arrived at. An onchain feed read is never a cross. */
  readonly derivation: "oracle-direct";
  /**
   * The instant the feed itself publishes for this price: a Chainlink round's
   * `updatedAt`, or a Pyth price's `publishTime`. Never the time the response
   * arrived — that would make every reading look fresh.
   *
   * A DECIMAL STRING, because it is a uint256 the contract chose: through
   * `Number()` a word of 2^255 prints as `5.78960446186581e+76`, which is
   * neither the value nor a timestamp, in a package whose whole point is that
   * chain quantities do not go through a double.
   */
  readonly publishedAt: string;
  readonly publishedAtSource: "chainlink.updatedAt" | "pyth.publishTime";
  /** The round this answer belongs to. Chainlink only. */
  readonly roundId?: string;
  readonly priceId?: string;
};

export type ChainlinkSignals = {
  /**
   * `answeredInRound < roundId` — the round has opened but no answer has been
   * carried into it. THIS is the incomplete-round signal, not elapsed time.
   */
  readonly answeredInRoundBehindRoundId: boolean;
  readonly roundId: string;
  readonly answeredInRound: string;
  /** A round that has never been updated. `updatedAt === 0` on a fresh feed. */
  readonly updatedAtZero: boolean;
  /** A price feed answering zero or less is broken, not cheap. */
  readonly answerNotPositive: boolean;
  /**
   * `now - updatedAt`, from the injected clock, or NULL when `updatedAt` is not
   * a time this can subtract: a uint256 too large to be a unix second, or one
   * far enough ahead of the clock that the feed is not describing the past.
   * Null means unknown, and every consumer of it has to say so too.
   */
  readonly secondsSinceUpdate: number | null;
  /**
   * `secondsSinceUpdate > heartbeatSeconds`, or null when no heartbeat was
   * supplied. Read it as a QUESTION: an aggregator updates on heartbeat or on
   * a deviation threshold, so a quiet market legitimately sits past its
   * heartbeat without anything being wrong.
   *
   * Also null when the age is unknown. `false` is a claim — "this feed is
   * inside its heartbeat" — and a threshold that could not be evaluated must
   * never be reported as one that held: a feed dated a year into the future
   * otherwise passes every freshness gate in the building.
   */
  readonly beyondHeartbeat: boolean | null;
  readonly heartbeatSeconds: number | null;
  /**
   * `updatedAt` is ahead of the clock by more than the tolerance below. A
   * couple of seconds is ordinary block-timestamp skew; a week is a broken
   * feed, a wrong proxy address, or a contract that answers whatever it likes.
   */
  readonly updatedAtInFuture: boolean;
  /** `updatedAt` is not a plausible unix second, so no age could be taken from it. */
  readonly updatedAtOutOfRange: boolean;
};

export type PythSignals = {
  /**
   * `confidence / |price|` in basis points. This is Pyth's own uncertainty
   * measure and it is what "stale" means on a Pyth feed — a widening band is
   * the publisher set disagreeing, which is a different event from an old
   * timestamp and is not comparable to a Chainlink heartbeat.
   */
  readonly confidenceToPriceBps: number;
  /** `confidenceToPriceBps > maxConfidenceBps`, or null when no bound was given. */
  readonly beyondConfidenceBound: boolean | null;
  readonly maxConfidenceBps: number | null;
  readonly priceNotPositive: boolean;
  /** As for Chainlink: null when `publishTime` is not a time this can subtract. */
  readonly secondsSincePublish: number | null;
  readonly publishTimeInFuture: boolean;
  readonly publishTimeOutOfRange: boolean;
};

export type OracleReading =
  | {
      readonly kind: "chainlink";
      readonly price: string;
      readonly decimals: number;
      /** The feed's own label, e.g. "ETH / USD" — the cheapest check that the pinned address is the feed you meant. */
      readonly description: string | null;
      readonly startedAt: string;
      readonly updatedAt: string;
      readonly signals: ChainlinkSignals;
      readonly provenance: OracleProvenance;
      readonly notes: ReadonlyArray<string>;
    }
  | {
      readonly kind: "pyth";
      readonly price: string;
      readonly confidence: string;
      readonly exponent: number;
      readonly publishTime: string;
      readonly signals: PythSignals;
      readonly provenance: OracleProvenance;
      readonly notes: ReadonlyArray<string>;
    };

/** The exact value behind `price`, for arithmetic that must not go through a string. */
export type OracleValue = { readonly reading: OracleReading; readonly value: Fixed };

export type ChainlinkRequest = {
  readonly chainId: string;
  readonly endpoint: string;
  readonly address: string;
  readonly blockTag: string;
  readonly heartbeatSeconds?: number;
  readonly multicall3?: string;
};

/** A Chainlink `decimals()` past this is not a feed. */
const MAX_FEED_DECIMALS = 36;

/**
 * How far ahead of the clock a feed's own timestamp may sit and still be read
 * as the past.
 *
 * A block timestamp is the proposer's, not ours, and reading at the head can
 * legitimately land a couple of seconds ahead of a local clock. Past that, the
 * feed is not describing something that has happened, and no age subtracted
 * from it means anything.
 */
const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

/** Past this a uint256 is not a unix second — year 10000 is 253402300800. */
const MAX_PLAUSIBLE_UNIX_SECONDS = 253_402_300_800n;

export type FeedAge = {
  readonly secondsSince: number | null;
  readonly inFuture: boolean;
  readonly outOfRange: boolean;
  readonly note: string | null;
};

/**
 * The age of a contract-supplied timestamp, in bigint, or the reason there is
 * no age.
 *
 * `Number(updatedAt)` was the original shape and it is the trap: a word of
 * 2^255 becomes 5.8e76, `now - that` is a large negative number, and a
 * negative age compares as comfortably inside every heartbeat there is.
 */
export function feedAge(timestamp: bigint, what: string): FeedAge {
  if (timestamp > MAX_PLAUSIBLE_UNIX_SECONDS) {
    return {
      secondsSince: null,
      inFuture: true,
      outOfRange: true,
      note: `${what} is ${timestamp.toString()}, which is not a unix timestamp — no age can be taken from it, so its freshness is unknown rather than fine`,
    };
  }
  const delta = BigInt(nowSeconds()) - timestamp;
  const seconds = Number(delta);
  if (delta < -BigInt(CLOCK_SKEW_TOLERANCE_SECONDS)) {
    return {
      secondsSince: seconds,
      inFuture: true,
      outOfRange: false,
      note: `${what} is ${-seconds}s AHEAD of the clock, past the ${CLOCK_SKEW_TOLERANCE_SECONDS}s of block-timestamp skew this tolerates — a feed dated in the future has no age, and anything comparing it against a heartbeat would find it comfortably fresh`,
    };
  }
  return { secondsSince: seconds, inFuture: false, outOfRange: false, note: null };
}

export async function readChainlink(
  request: ChainlinkRequest,
  options: RpcOptions = {},
): Promise<OracleValue> {
  const contract = normalizeAddress(request.address, "the Chainlink feed address");
  const calls: BatchCall[] = [
    { to: contract, data: callNoArgs(SELECTORS.latestRoundData), label: "latestRoundData()" },
    { to: contract, data: callNoArgs(SELECTORS.decimals), label: "decimals()" },
    { to: contract, data: callNoArgs(SELECTORS.description), label: "description()" },
  ];
  const results = await batchCalls(request.endpoint, calls, request.blockTag, {
    ...options,
    chainId: request.chainId,
    ...(request.multicall3 === undefined ? {} : { multicall3: request.multicall3 }),
  });

  const round = required(results[0], "latestRoundData()");
  const decimalsData = required(results[1], "decimals()");

  const [roundId, answerWord, startedAt, updatedAt, answeredInRound] = decodeWords(
    round,
    5,
    "latestRoundData()",
  ) as [bigint, bigint, bigint, bigint, bigint];
  const answer = asSigned(answerWord, 256);

  const decimals = Number(decodeWords(decimalsData, 1, "decimals()")[0] as bigint);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_FEED_DECIMALS) {
    throw new DefiError(
      `the feed at ${contract} answered decimals() with ${decimals}; a price feed has 0 to ${MAX_FEED_DECIMALS}`,
    );
  }

  // `description()` is not on every aggregator ever deployed, so its failure is
  // a missing label rather than a failed read — but the reason is kept, because
  // "this address has no description()" is also what a wrong address looks like.
  const notes: string[] = [];
  const descriptionResult = results[2];
  let description: string | null = null;
  if (descriptionResult?.ok) {
    try {
      // Sanitised, because this is the one free-text field in the output and a
      // contract's bytes are written by whoever deployed it — not by the caller
      // who was handed the address. A real aggregator's label is nine
      // characters; anything longer is using the result as a delivery route.
      const decoded = sanitizeContractText(decodeString(descriptionResult.data, "description()"));
      description = decoded.text;
      if (decoded.truncated) {
        notes.push(
          `description() was longer than ${MAX_CONTRACT_TEXT_CHARS} characters and is shown truncated — a real feed's label is "ETH / USD", so treat a long one as a reason to check the address rather than as a label`,
        );
      }
      if (decoded.hadControlCharacters) {
        notes.push(
          "description() contained control characters, which are replaced here: returned bytes carrying newlines can impersonate the lines printed around them",
        );
      }
    } catch (err) {
      notes.push(`description() did not decode as a string: ${(err as Error).message}`);
    }
  } else if (descriptionResult !== undefined) {
    notes.push(
      `description() could not be read (${descriptionResult.reason}) — the feed's own label is the cheapest check that this address is the pair you meant`,
    );
  }

  const value = fixed(answer, decimals);
  const age = feedAge(updatedAt, "the round's updatedAt");
  if (age.note !== null) notes.push(age.note);
  const heartbeatSeconds = request.heartbeatSeconds ?? null;

  if (answeredInRound < roundId) {
    notes.push(
      "answeredInRound is behind roundId: a round has opened that no answer has been carried into, so this price belongs to an earlier round",
    );
  }
  if (updatedAt === 0n) {
    notes.push(
      "updatedAt is zero — this round has never been completed, and the answer means nothing",
    );
  }
  if (answer <= 0n) {
    notes.push("the feed answered zero or less, which is a broken feed rather than a low price");
  }

  return {
    value,
    reading: {
      kind: "chainlink",
      // Trimmed: the feed's scale is reported as `decimals`, so eight trailing
      // zeros in the price would read as significance the feed did not claim.
      price: toDecimalString(trim(value)),
      decimals,
      description,
      startedAt: startedAt.toString(),
      updatedAt: updatedAt.toString(),
      signals: {
        answeredInRoundBehindRoundId: answeredInRound < roundId,
        roundId: roundId.toString(),
        answeredInRound: answeredInRound.toString(),
        updatedAtZero: updatedAt === 0n,
        answerNotPositive: answer <= 0n,
        secondsSinceUpdate: age.secondsSince,
        // Three ways to be null, and `false` is never one of them: no
        // heartbeat to compare against, no age to compare, or an age that runs
        // the wrong way. Each is "this was not evaluated", which is a
        // different answer from "it held".
        beyondHeartbeat:
          heartbeatSeconds === null || age.secondsSince === null || age.inFuture
            ? null
            : age.secondsSince > heartbeatSeconds,
        heartbeatSeconds,
        updatedAtInFuture: age.inFuture,
        updatedAtOutOfRange: age.outOfRange,
      },
      provenance: {
        source: "chainlink",
        chainId: request.chainId,
        endpoint: endpointLabel(request.endpoint),
        contract,
        blockTag: request.blockTag,
        derivation: "oracle-direct",
        publishedAt: updatedAt.toString(),
        publishedAtSource: "chainlink.updatedAt",
        roundId: roundId.toString(),
      },
      notes,
    },
  };
}

export type PythRequest = {
  readonly chainId: string;
  readonly endpoint: string;
  readonly address: string;
  readonly priceId: string;
  readonly blockTag: string;
  readonly maxConfidenceBps?: number;
  readonly multicall3?: string;
};

export async function readPyth(
  request: PythRequest,
  options: RpcOptions = {},
): Promise<OracleValue> {
  const contract = normalizeAddress(request.address, "the Pyth contract address");
  const priceId = normalizeBytes32(request.priceId, "the Pyth price id");
  const calls: BatchCall[] = [
    {
      to: contract,
      data: callWithBytes32(SELECTORS.getPriceUnsafe, priceId, "the Pyth price id"),
      label: "getPriceUnsafe(bytes32)",
    },
  ];
  const results = await batchCalls(request.endpoint, calls, request.blockTag, {
    ...options,
    chainId: request.chainId,
    ...(request.multicall3 === undefined ? {} : { multicall3: request.multicall3 }),
  });
  const data = required(results[0], "getPriceUnsafe(bytes32)");

  // PythStructs.Price is (int64 price, uint64 conf, int32 expo, uint publishTime).
  // Every member is static, so the struct is four words inline — no offset.
  const [priceWord, confWord, expoWord, publishWord] = decodeWords(
    data,
    4,
    "getPriceUnsafe(bytes32)",
  ) as [bigint, bigint, bigint, bigint];
  const rawPrice = asSigned(priceWord, 64);
  const confidence = asSigned(confWord, 64);
  // `expo` is an int32 and is almost always NEGATIVE: -8 means the integer is
  // scaled by 1e-8. Read unsigned it is about 4.29e9, and the price comes back
  // as a number with four billion zeros after it.
  const exponent = Number(asSigned(expoWord, 32));
  if (!Number.isSafeInteger(exponent) || exponent < -60 || exponent > 60) {
    throw new DefiError(
      `the Pyth feed answered an exponent of ${exponent}, outside the range this reads`,
    );
  }
  const publishTime = publishWord;

  const value = fixed(rawPrice, -exponent);
  const confidenceValue = fixed(confidence, -exponent);
  const notes: string[] = [];

  let confidenceToPriceBps = 0;
  if (isPositive(value)) {
    confidenceToPriceBps = ratioBps(confidenceValue, value);
  } else {
    notes.push(
      "the Pyth feed answered a price of zero or less, so its confidence ratio is undefined",
    );
  }
  const maxConfidenceBps = request.maxConfidenceBps ?? null;
  if (maxConfidenceBps !== null && isPositive(value) && confidenceToPriceBps > maxConfidenceBps) {
    notes.push(
      `the confidence band is ${confidenceToPriceBps} bps of the price, past the ${maxConfidenceBps} bps bound supplied — on Pyth this, not elapsed time, is the freshness signal`,
    );
  }
  if (publishTime === 0n) {
    notes.push("publishTime is zero — this price id has never been updated on this contract");
  }
  const age = feedAge(publishTime, "the price's publishTime");
  if (age.note !== null) notes.push(age.note);

  return {
    value,
    reading: {
      kind: "pyth",
      price: toDecimalString(trim(value)),
      confidence: toDecimalString(trim(confidenceValue)),
      exponent,
      publishTime: publishTime.toString(),
      signals: {
        confidenceToPriceBps,
        beyondConfidenceBound:
          maxConfidenceBps === null || !isPositive(value)
            ? null
            : confidenceToPriceBps > maxConfidenceBps,
        maxConfidenceBps,
        priceNotPositive: !isPositive(value),
        secondsSincePublish: age.secondsSince,
        publishTimeInFuture: age.inFuture,
        publishTimeOutOfRange: age.outOfRange,
      },
      provenance: {
        source: "pyth",
        chainId: request.chainId,
        endpoint: endpointLabel(request.endpoint),
        contract,
        blockTag: request.blockTag,
        derivation: "oracle-direct",
        publishedAt: publishTime.toString(),
        publishedAtSource: "pyth.publishTime",
        priceId,
      },
      notes,
    },
  };
}

function required(outcome: CallOutcome | undefined, label: string): string {
  if (outcome === undefined) throw new DefiError(`the batch returned no row for ${label}`);
  if (!outcome.ok) throw new DefiError(outcome.reason);
  return outcome.data;
}
