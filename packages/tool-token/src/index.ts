/**
 * @crewhaus/tool-token — which token is this, and how much of it is there.
 *
 * Three reads, and one rule that shapes all of them: **ambiguity is a
 * refusal, not a best guess.**
 *
 * A symbol is not an identifier. Nothing stops a second contract from calling
 * itself USDC with six decimals and a convincing name, reputable token lists
 * routinely disagree about which address a ticker means, and a harness that
 * sends funds to the first match of a symbol is the accident this package
 * exists to prevent. So `TokenResolve` never returns a "most likely" — when a
 * query could mean more than one address it returns every candidate, each
 * flagged with what is wrong with it, and `resolved: false`.
 *
 * The other rule is arithmetic. Decimals come from the contract, never from a
 * list and never from a default: a token whose `decimals()` reverts is
 * reported as unknown, and its balances come back as exact base units with no
 * decimal form at all. Assuming 18 is how a six-decimal transfer becomes a
 * trillion-fold one. Every quantity here is a bigint or a decimal string;
 * nothing that came off a chain is ever a JS number.
 *
 * ## Nothing here signs or sends
 *
 * No schema in this package has a field a private key could be passed to, no
 * code path composes a transaction, and the three JSON-RPC methods it can
 * emit are `eth_call`, `eth_getBalance` and `eth_getCode` — enforced in
 * `lib/chain.ts` and asserted in `index.test.ts`.
 *
 * ## Two seams, no dialling code
 *
 * There is no RPC client and no HTTP client in this package. Chain reads
 * leave through `_setChainReader` and metadata fetches through
 * `_setMetadataFetch`. A bundle binds them at boot from the spec —
 * `bindTokenChains` from its `chains` block, `registerTokenConfig` from
 * `tool_config.token.metadata_origins` (`lib/boot.ts`) — and every test drives
 * them from recorded answers, so the suite cannot reach the network even by
 * accident.
 */
import { createHash } from "node:crypto";
import { CHAINS_BLOCK_EXAMPLE } from "@crewhaus/chain-adapter-base";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { MULTICALL3_ADDRESS } from "@crewhaus/tool-onchain";
import { z } from "zod";
import {
  type BatchCall,
  type CallOutcome,
  TokenError,
  hasChainReader,
  nativeBalanceCall,
  readCalls,
  readHasCode,
  readNativeBalance,
} from "./lib/chain";
import {
  INTERFACE_ID,
  SELECTOR,
  type StringRead,
  addressWord,
  bytes4Word,
  callData,
  decodeAddressValue,
  decodeBool,
  decodeStringish,
  decodeUint,
  padTokenIdHex,
  uintWord,
} from "./lib/erc";
import {
  ADDRESS_SHAPE,
  type Candidate,
  type TokenList,
  confusableSkeleton,
  findCandidates,
  fingerprintLists,
  textConcerns,
} from "./lib/lists";
import { MAX_FORMATTABLE_DECIMALS, checkAddress, formatUnits } from "./lib/onchain";
import {
  DEFAULT_MAX_METADATA_BYTES,
  type ReferencedUrl,
  type UriPlan,
  decodeDataUri,
  fetchDocument,
  planUri,
  referencedUrls,
} from "./lib/uri";

export {
  type ChainRead,
  type ChainReadMethod,
  type ChainReader,
  READ_METHODS,
  TokenError,
  _setChainReader,
  chainReaderFromAdapters,
  hasChainReader,
} from "./lib/chain";
export { type TokenConfigInput, bindTokenChains, registerTokenConfig } from "./lib/boot";
export {
  type MetadataFetch,
  type MetadataResponse,
  type UriPlan,
  DEFAULT_MAX_METADATA_BYTES,
  _setMetadataFetch,
  planUri,
} from "./lib/uri";
export {
  type Candidate,
  type TokenList,
  type TokenListEntry,
  confusableSkeleton,
  findCandidates,
  textConcerns,
} from "./lib/lists";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = { accounts: 100, lists: 16, tokensPerList: 20_000, hosts: 32 } as const;

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const chainIdField = z
  .number()
  .int()
  .positive()
  .describe("EVM chain id — 1 for Ethereum mainnet, 8453 for Base");

const blockTagField = z
  .string()
  .min(1)
  .max(32)
  .optional()
  .describe("latest (default), safe, finalized, or a 0x hex block number for a fixed snapshot");

const batchField = z
  .boolean()
  .optional()
  .describe(
    "read every call in one Multicall3 eth_call so the answers share a block; default true. false reads them one at a time, which is not a snapshot",
  );

const multicallField = z
  .string()
  .optional()
  .describe(`Multicall3's address on this chain; default ${MULTICALL3_ADDRESS}`);

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Validate an address, or refuse by name so the caller knows WHICH one is wrong. */
async function requireAddress(raw: string, what: string): Promise<string> {
  const verdict = await checkAddress(raw);
  if (!verdict.valid) throw new TokenError(`${what} "${raw}": ${verdict.reason}`);
  return verdict.checksummed;
}

const lower = (address: string): string => address.toLowerCase();

/** A text field as the answer reports it: the value, how it was encoded, and what is odd about it. */
type TextField = {
  readonly value: string | null;
  readonly encoding: StringRead["encoding"];
  readonly note: string;
  readonly concerns: ReturnType<typeof textConcerns>;
};

function textField(outcome: CallOutcome | undefined): TextField {
  if (outcome === undefined) {
    return { value: null, encoding: "absent", note: "not read", concerns: [] };
  }
  if (!outcome.ok) {
    return {
      value: null,
      encoding: "absent",
      note: `the call failed: ${outcome.revert?.reason ?? outcome.revert?.kind ?? outcome.error ?? "no reason given"}`,
      concerns: [],
    };
  }
  const read = decodeStringish(outcome.data);
  return {
    value: read.value,
    encoding: read.encoding,
    note: read.note,
    concerns: read.value === null ? [] : textConcerns(read.value),
  };
}

function uintField(outcome: CallOutcome | undefined): bigint | null {
  if (outcome === undefined || !outcome.ok) return null;
  return decodeUint(outcome.data);
}

/** How the decimals used for scaling were arrived at. There is no "assumed" arm. */
type Decimals = {
  readonly value: number | null;
  readonly source: "contract" | "unreadable" | "chain-convention";
  readonly note: string;
  /** False when nothing may be scaled by it, so every amount stays raw. */
  readonly formattable: boolean;
};

function decimalsFrom(outcome: CallOutcome | undefined): Decimals {
  const raw = uintField(outcome);
  if (raw === null) {
    return {
      value: null,
      source: "unreadable",
      note:
        outcome !== undefined && !outcome.ok
          ? `decimals() reverted (${outcome.revert?.reason ?? outcome.revert?.kind ?? outcome.error ?? "no reason"}), so the token's scale is unknown — it is NOT 18 by default`
          : "decimals() returned no data, so the token's scale is unknown — it is NOT 18 by default",
      formattable: false,
    };
  }
  if (raw > 255n) {
    return {
      value: null,
      source: "unreadable",
      note: `decimals() answered ${raw}, which does not fit in the uint8 the standard declares`,
      formattable: false,
    };
  }
  const value = Number(raw);
  if (value > MAX_FORMATTABLE_DECIMALS) {
    return {
      value,
      source: "contract",
      note: `the token claims ${value} decimals; amounts are left in base units because nothing legitimate is scaled that far`,
      formattable: false,
    };
  }
  return { value, source: "contract", note: "", formattable: true };
}

/** Base units as an exact decimal string, or null when the scale is unknown. */
async function scaled(raw: bigint, decimals: Decimals): Promise<string | null> {
  if (!decimals.formattable || decimals.value === null) return null;
  return formatUnits(raw, decimals.value);
}

const ERC20_KEYS = {
  decimals: "decimals",
  symbol: "symbol",
  name: "name",
  supply: "supply",
} as const;

function erc20MetadataCalls(prefix: string, token: string): BatchCall[] {
  return [
    {
      key: `${prefix}${ERC20_KEYS.decimals}`,
      target: token,
      callData: callData(SELECTOR.decimals),
    },
    { key: `${prefix}${ERC20_KEYS.symbol}`, target: token, callData: callData(SELECTOR.symbol) },
    { key: `${prefix}${ERC20_KEYS.name}`, target: token, callData: callData(SELECTOR.name) },
    {
      key: `${prefix}${ERC20_KEYS.supply}`,
      target: token,
      callData: callData(SELECTOR.totalSupply),
    },
  ];
}

type Erc20Facts = {
  readonly decimals: Decimals;
  readonly symbol: TextField;
  readonly name: TextField;
  readonly totalSupply: string | null;
};

function erc20Facts(prefix: string, outcomes: ReadonlyMap<string, CallOutcome>): Erc20Facts {
  const supply = uintField(outcomes.get(`${prefix}${ERC20_KEYS.supply}`));
  return {
    decimals: decimalsFrom(outcomes.get(`${prefix}${ERC20_KEYS.decimals}`)),
    symbol: textField(outcomes.get(`${prefix}${ERC20_KEYS.symbol}`)),
    name: textField(outcomes.get(`${prefix}${ERC20_KEYS.name}`)),
    totalSupply: supply === null ? null : supply.toString(),
  };
}

/** Everything odd about a token's own answers, as lines a human can act on. */
function metadataWarnings(facts: Erc20Facts): string[] {
  const out: string[] = [];
  if (!facts.decimals.formattable) out.push(facts.decimals.note);
  for (const [label, field] of [
    ["symbol", facts.symbol],
    ["name", facts.name],
  ] as const) {
    if (field.encoding === "bytes32") {
      out.push(
        `${label}() returned a bytes32 rather than a string — the pre-standard form MKR and other 2017-era tokens use. It was decoded as text.`,
      );
    }
    if (field.encoding === "absent" || field.encoding === "undecodable") {
      out.push(`${label}() could not be read: ${field.note}`);
    }
    for (const concern of field.concerns) out.push(`${label} ${concern.detail}`);
  }
  if (facts.totalSupply === null) out.push("totalSupply() could not be read");
  return out;
}

/**
 * A batch whose `getBlockNumber()` did not answer is not the snapshot the
 * batched path promises. The calls still shared one `eth_call`, so they are
 * consistent with each other — but nothing in the answer says which block
 * they are consistent AT, and a caller pinning a later read to it has nothing
 * to pin to.
 */
const NO_BLOCK_NUMBER =
  "the batch did not report a block number, so these answers cannot be pinned to a block — they share an eth_call, but which block that read is unknown";

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// ---------------------------------------------------------------------------
// TokenResolve
// ---------------------------------------------------------------------------

const tokenListSchema = z.object({
  id: z.string().min(1).max(128).describe("how the answer refers to this list"),
  name: z.string().max(256).optional(),
  tokens: z
    .array(
      z.object({
        chainId: z.number().int().positive(),
        address: z.string().min(1),
        symbol: z.string(),
        name: z.string(),
        decimals: z.number().int().min(0).max(255),
        tags: z.array(z.string()).optional(),
      }),
    )
    .max(LIMITS.tokensPerList),
});

type Flagged = {
  readonly address: string;
  readonly checksummed: string;
  readonly matchedBy: ReadonlyArray<string>;
  readonly claims: Candidate["claims"];
  readonly onchain: (Erc20Facts & { hasCode: boolean | null }) | null;
  readonly flags: ReadonlyArray<string>;
};

/** The concerns that mean a name was BUILT to read as another one. */
const NAME_ATTACK_CODES: ReadonlySet<string> = new Set(["invisible-characters", "confusable"]);

/** Confirm one candidate against the chain and say what does not line up. */
function flagsFor(
  candidate: Candidate,
  facts: (Erc20Facts & { hasCode: boolean | null }) | null,
): string[] {
  const flags: string[] = [];
  if (candidate.claims.length === 0) flags.push("not-listed");
  else if (candidate.claims.length === 1) flags.push("single-list");
  if (
    candidate.matchedBy.includes("symbol-confusable") ||
    candidate.matchedBy.includes("name-confusable")
  ) {
    flags.push("confusable-match");
  }
  const claimedSymbols = new Set(candidate.claims.map((c) => c.symbol));
  const claimedDecimals = new Set(candidate.claims.map((c) => c.decimals));
  if (claimedSymbols.size > 1) flags.push("lists-disagree-on-symbol");
  if (claimedDecimals.size > 1) flags.push("lists-disagree-on-decimals");
  for (const claim of candidate.claims) {
    if (textConcerns(claim.symbol).length > 0) flags.push("suspicious-listed-symbol");
  }
  if (facts === null) return [...new Set(flags)];

  if (facts.hasCode === false) flags.push("no-code");
  if (facts.decimals.value === null) flags.push("decimals-unreadable");
  if (facts.symbol.encoding === "absent") flags.push("symbol-unreadable");
  if (facts.symbol.concerns.length > 0) flags.push("suspicious-onchain-symbol");
  // The name is the string a wallet puts in front of a human, so a homoglyph
  // or a zero-width character in it is the same attack as one in the symbol.
  // Only those two codes, not every concern: plenty of real tokens have a
  // non-ASCII name, and flagging those would make `verified` mean nothing.
  if (facts.name.concerns.some((c) => NAME_ATTACK_CODES.has(c.code))) {
    flags.push("suspicious-onchain-name");
  }
  for (const claim of candidate.claims) {
    if (facts.decimals.value !== null && claim.decimals !== facts.decimals.value) {
      flags.push("decimals-mismatch");
    }
    if (
      facts.symbol.value !== null &&
      claim.symbol !== "" &&
      claim.symbol.toLowerCase() !== facts.symbol.value.toLowerCase()
    ) {
      flags.push("symbol-mismatch");
    }
  }
  if (facts.totalSupply === "0") flags.push("zero-total-supply");
  return [...new Set(flags)];
}

/**
 * The flags that mean "do not act on this without looking". Everything else
 * `flagsFor` produces is context: being on one list is how a new token starts
 * out, and reporting it as a defect would make `verified` useless.
 */
const CONCERNING_FLAGS: ReadonlySet<string> = new Set([
  "no-code",
  "not-listed",
  "confusable-match",
  "lists-disagree-on-symbol",
  "lists-disagree-on-decimals",
  "suspicious-listed-symbol",
  "suspicious-onchain-symbol",
  "suspicious-onchain-name",
  "decimals-unreadable",
  "decimals-mismatch",
  "symbol-unreadable",
  "symbol-mismatch",
  "zero-total-supply",
]);

export const tokenResolve: RegisteredTool = buildTool({
  name: "TokenResolve",
  operativeArgs: [{ field: "query", kind: "text", within: "chainId" }],
  description:
    "Turn a token symbol, name or address into ONE checksummed address, confirmed against the contract itself — or refuse and show you why. Use it before any transfer, balance read or approval, because a symbol is not an identifier: nothing stops a second contract calling itself USDC with six decimals and a convincing name, and reputable token lists carry different addresses for the same ticker. When a query could mean more than one address this returns EVERY candidate with resolved:false rather than the first hit or a most-likely, because picking between them is a decision with a wrong answer that costs money. Symbols that differ only by a Cyrillic lookalike or a zero-width space are pulled into the same candidate set on purpose, so an impostor a literal match would miss becomes an ambiguity you have to look at. The contract's own decimals and symbol are compared against what the lists claim, and a decimals mismatch is a refusal rather than a footnote.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      query: z
        .string()
        .min(1)
        .max(256)
        .describe("a symbol (USDC), a name (USD Coin), or a 0x contract address"),
      lists: z
        .array(tokenListSchema)
        .max(LIMITS.lists)
        .optional()
        .describe(
          "token lists to resolve against, in the Uniswap token-list shape. Supplied by the caller rather than fetched here, so the same lists give the same answer",
        ),
      policy: z
        .enum(["listed-only", "allow-unlisted"])
        .optional()
        .describe(
          "listed-only (default) refuses an address no supplied list carries; allow-unlisted resolves it anyway and flags it",
        ),
      confirmOnchain: z
        .boolean()
        .optional()
        .describe(
          "read decimals/symbol/name/totalSupply from the contract; default true when a chain reader is bound",
        ),
      checkCode: z
        .boolean()
        .optional()
        .describe("check there is a contract at the address; default true"),
      maxCandidates: z
        .number()
        .int()
        .min(1)
        .max(32)
        .optional()
        .describe("how many candidates to confirm onchain before refusing outright; default 8"),
      blockTag: blockTagField,
      batch: batchField,
      multicall3Address: multicallField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: the confirmation reads cross a network boundary
  // through whatever the runtime bound to the seam.
  scope: "external",
  ioCapability: "network",
  execute: async (input) => {
    const query = input.query.trim();
    const lists = (input.lists ?? []) as ReadonlyArray<TokenList>;
    const policy = input.policy ?? "listed-only";
    const maxCandidates = input.maxCandidates ?? 8;
    const blockTag = input.blockTag ?? "latest";
    const isAddressQuery = ADDRESS_SHAPE.test(query);

    const base = {
      chainId: input.chainId,
      query,
      queryKind: isAddressQuery ? "address" : "symbol-or-name",
      listsSearched: lists.map((l) => l.id),
      listsFingerprint: fingerprintLists(lists, input.chainId),
    } as const;
    const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): string =>
      json({ ...base, resolved: false, refusal: { code, message }, ...extra });

    // A query that is itself confusable is the direction of this attack that
    // widening the candidate set cannot help with: the caller pasted the
    // impostor's ticker, so a literal match finds the impostor and nothing
    // looks wrong. It is refused before anything is searched.
    const queryConcerns = textConcerns(query);
    if (!isAddressQuery && queryConcerns.some((c) => c.code !== "over-long")) {
      return refuse(
        "confusable-query",
        `the query itself is not plain ASCII: ${queryConcerns.map((c) => c.detail).join("; ")}. It folds to "${confusableSkeleton(query)}". Resolving it would find whatever token was named with those exact characters, which is how a pasted ticker leads somewhere else — pass the address instead.`,
        { queryConcerns },
      );
    }

    if (isAddressQuery) {
      const verdict = await checkAddress(query);
      if (!verdict.valid) {
        return refuse("invalid-address", `"${query}": ${verdict.reason}`);
      }
      if (verdict.isZero) {
        return refuse("zero-address", "the zero address is not a token");
      }
    }
    if (!isAddressQuery && lists.length === 0) {
      return refuse(
        "no-lists",
        "a symbol cannot be resolved without a token list to resolve it against, and this package will not pick one for you. Supply lists, or pass the contract address.",
      );
    }

    let candidates = findCandidates(lists, input.chainId, query);
    if (isAddressQuery && candidates.length === 0) {
      // An address is self-identifying, so an unlisted one is still a
      // candidate — with nothing vouching for it, which is the flag.
      candidates = [{ address: lower(query), claims: [], matchedBy: ["address"] }];
    }
    if (candidates.length === 0) {
      return refuse(
        "no-candidates",
        `no token on ${lists.length} list(s) for chain ${input.chainId} has the symbol or name "${query}"`,
      );
    }
    if (candidates.length > maxCandidates) {
      return refuse(
        "too-many-candidates",
        `"${query}" matches ${candidates.length} different addresses on chain ${input.chainId}, more than the ${maxCandidates} this will confirm. A symbol matching that many contracts is not a way to name one.`,
        { candidateAddresses: candidates.map((c) => c.address) },
      );
    }

    // Nothing in the token-list schema says the `address` field holds an
    // address — a list is caller input and carries whatever it carries. An
    // entry that is not one used to travel all the way to the answer as
    // `token.address: ""`, which is what the checksummer returns for a string
    // it cannot read, or to reach the ABI encoder and come back as
    // "call[1].target" with no mention of the list that caused it. Checked
    // here, after the candidate cap, so a 20,000-token list is not
    // checksummed end to end to answer one query.
    for (const candidate of candidates) {
      const verdict = await checkAddress(candidate.address);
      const listedBy = candidate.claims.map((c) => c.listId).join(", ");
      if (!verdict.valid) {
        return refuse(
          "invalid-list-address",
          `${listedBy === "" ? "a candidate" : `list "${listedBy}"`} carries "${candidate.address}" as the address of "${query}", and that is not an address: ${verdict.reason}. A list that cannot spell an address is not one to resolve a token against.`,
          { badAddress: candidate.address },
        );
      }
      // The zero address is refused for a pasted address already. It reaches
      // here by the other door — a list entry whose address field is zero —
      // and burns tokens just as irreversibly when it does.
      if (verdict.isZero) {
        return refuse(
          "zero-address",
          `"${query}" resolves to the zero address${listedBy === "" ? "" : ` on list "${listedBy}"`}. The zero address is not a token: it is where tokens go to be burned.`,
        );
      }
    }

    const wantsOnchain = input.confirmOnchain ?? true;
    if (wantsOnchain && !hasChainReader()) {
      if (input.confirmOnchain === true) {
        throw new TokenError(
          `confirmOnchain was asked for but no chain is configured. Declare one in the spec — ${CHAINS_BLOCK_EXAMPLE} — or pass confirmOnchain:false to answer from the lists alone`,
        );
      }
    }
    const confirm = wantsOnchain && hasChainReader();

    const facts = new Map<string, Erc20Facts & { hasCode: boolean | null }>();
    let blockNumber: string | null = null;
    if (confirm) {
      const calls: BatchCall[] = [];
      for (const [i, candidate] of candidates.entries()) {
        calls.push(...erc20MetadataCalls(`c${i}:`, candidate.address));
      }
      const read = await readCalls({
        chainId: input.chainId,
        calls,
        blockTag,
        batch: input.batch ?? true,
        ...(input.multicall3Address !== undefined
          ? { multicall3Address: input.multicall3Address }
          : {}),
      });
      blockNumber = read.blockNumber;
      for (const [i, candidate] of candidates.entries()) {
        const hasCode =
          (input.checkCode ?? true)
            ? (await readHasCode(input.chainId, candidate.address, blockTag)).hasCode
            : null;
        facts.set(candidate.address, { ...erc20Facts(`c${i}:`, read.outcomes), hasCode });
      }
    }

    const flagged: Flagged[] = [];
    for (const candidate of candidates) {
      const onchain = facts.get(candidate.address) ?? null;
      flagged.push({
        address: candidate.address,
        checksummed: (await checkAddress(candidate.address)).checksummed,
        matchedBy: candidate.matchedBy,
        claims: candidate.claims,
        onchain,
        flags: flagsFor(candidate, onchain),
      });
    }

    const shared = { ...base, blockNumber, confirmedOnchain: confirm, candidates: flagged };

    if (flagged.length > 1) {
      return json({
        ...shared,
        resolved: false,
        refusal: {
          code: "ambiguous-symbol",
          message: `"${query}" means ${flagged.length} different addresses on chain ${input.chainId}. Every one of them is below with what is wrong with it; none is returned as the answer, because choosing between two contracts that both say "${query}" is not something a string match is entitled to do. Pass the address you mean.`,
        },
      });
    }

    const only = flagged[0] as Flagged;
    if (only.flags.includes("no-code")) {
      return json({
        ...shared,
        resolved: false,
        refusal: {
          code: "not-a-contract",
          message: `there is no contract at ${only.checksummed} at block ${blockNumber ?? blockTag}. Every call to it answers 0x, which decodes as a zero balance for everyone and an empty symbol — it is somebody's wallet, or a typo.`,
        },
      });
    }
    if (only.flags.includes("decimals-mismatch")) {
      return json({
        ...shared,
        resolved: false,
        refusal: {
          code: "decimals-mismatch",
          message: `the contract at ${only.checksummed} reports ${only.onchain?.decimals.value} decimals and the list says ${only.claims.map((c) => c.decimals).join("/")}. That is not a cosmetic disagreement: every amount computed from the wrong one is off by a power of ten.`,
        },
      });
    }
    if (policy === "listed-only" && only.claims.length === 0) {
      return json({
        ...shared,
        resolved: false,
        refusal: {
          code: "unlisted",
          message: `${only.checksummed} is on none of the supplied lists${lists.length === 0 ? " (none were supplied)" : ""}. Pass policy:"allow-unlisted" to resolve it anyway — the answer will still say nothing vouches for it.`,
        },
      });
    }

    const warnings = only.onchain === null ? [] : metadataWarnings(only.onchain);
    if (!confirm) {
      warnings.push(
        "nothing was confirmed against the chain, so this is what the lists say and no more",
      );
    }
    return json({
      ...shared,
      resolved: true,
      token: {
        address: only.checksummed,
        decimals: only.onchain?.decimals ?? null,
        symbol: only.onchain?.symbol ?? null,
        name: only.onchain?.name ?? null,
        totalSupply: only.onchain?.totalSupply ?? null,
        listedBy: only.claims.map((c) => c.listId),
      },
      /** True only when a contract confirmed the lists and nothing concerning was flagged. */
      verified: confirm && !only.flags.some((f) => CONCERNING_FLAGS.has(f)),
      warnings,
    });
  },
});

// ---------------------------------------------------------------------------
// Erc20Balance
// ---------------------------------------------------------------------------

export const erc20Balance: RegisteredTool = buildTool({
  name: "Erc20Balance",
  operativeArgs: [{ field: "token", kind: "id", within: "chainId" }],
  description:
    "Read ERC-20 balances, and optionally an allowance, for one or many accounts at one block — with the token's decimals taken from the CONTRACT, never from a list and never defaulted. Use it instead of a raw eth_call: every amount comes back both as exact base units and as a decimal string, so a uint256 never becomes a JS number and eighteen digits of precision never quietly become fifteen. A token whose decimals() reverts is reported as unknown and its balances stay in base units rather than being scaled by an assumed 18, which is how a six-decimal transfer becomes a trillion-fold one. Tokens that answer symbol() with a bytes32 instead of a string — MKR and other 2017-era contracts — are decoded rather than crashed on, and an address with no code at it is refused instead of reporting everyone's balance as zero. Pass \"native\" as the token to read the chain's own currency in the same snapshot. It takes a contract ADDRESS, not a symbol: use TokenResolve first.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      token: z
        .string()
        .min(1)
        .describe('the token CONTRACT ADDRESS, or "native" for the chain\'s own currency'),
      accounts: z
        .array(z.string().min(1))
        .min(1)
        .max(LIMITS.accounts)
        .describe("the addresses to read balances for"),
      spender: z
        .string()
        .optional()
        .describe("also read allowance(account, spender) for each account"),
      checkCode: z
        .boolean()
        .optional()
        .describe("check there is a contract at the token; default true"),
      blockTag: blockTagField,
      batch: batchField,
      multicall3Address: multicallField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input) => {
    const blockTag = input.blockTag ?? "latest";
    const batch = input.batch ?? true;
    const multicall = input.multicall3Address ?? MULTICALL3_ADDRESS;
    const isNative = input.token.trim().toLowerCase() === "native";

    if (!isNative && !ADDRESS_SHAPE.test(input.token.trim())) {
      throw new TokenError(
        `Erc20Balance takes a token contract address, not "${input.token}". A symbol is not an identifier — several contracts can claim the same one — so resolve it with TokenResolve first, which returns every candidate when a symbol is ambiguous rather than picking one.`,
      );
    }

    const accounts: Array<{ input: string; checksummed: string }> = [];
    for (const [i, raw] of input.accounts.entries()) {
      accounts.push({ input: raw, checksummed: await requireAddress(raw, `accounts[${i}]`) });
    }
    const spender =
      input.spender === undefined ? null : await requireAddress(input.spender, "spender");

    if (isNative) {
      const decimals: Decimals = {
        value: 18,
        source: "chain-convention",
        note: "the native currency's 18 decimals are the EVM convention, not a contract read — nothing was asked",
        formattable: true,
      };
      const balances: Array<Record<string, unknown>> = [];
      const warnings: string[] = [];
      let blockNumber: string | null = null;
      if (batch) {
        const read = await readCalls({
          chainId: input.chainId,
          calls: accounts.map((a, i) => nativeBalanceCall(`n${i}`, a.checksummed, multicall)),
          blockTag,
          batch: true,
          multicall3Address: multicall,
        });
        blockNumber = read.blockNumber;
        for (const [i, account] of accounts.entries()) {
          const outcome = read.outcomes.get(`n${i}`);
          const raw = uintField(outcome);
          const row: Record<string, unknown> = {
            account: account.checksummed,
            raw: raw === null ? null : raw.toString(),
            decimal: raw === null ? null : await scaled(raw, decimals),
          };
          if (raw === null) {
            // A balance nobody answered is not a balance of zero. Inside the
            // batch this is a contract call like any other — a Multicall3
            // deployment without the helper, or a sub-call that ran out of gas
            // — and "0 ETH" is the one wrong answer a gas check or a
            // drained-wallet check would act on without looking further.
            row["error"] =
              `getEthBalance did not answer through the Multicall3 at ${multicall}: ${outcome?.revert?.reason ?? outcome?.revert?.kind ?? outcome?.error ?? "no data"}. Pass batch:false to read it with eth_getBalance directly.`;
          }
          balances.push(row);
        }
      } else {
        for (const account of accounts) {
          const raw = await readNativeBalance(input.chainId, account.checksummed, blockTag);
          balances.push({
            account: account.checksummed,
            raw: raw.toString(),
            decimal: await scaled(raw, decimals),
          });
        }
        // The declaration the ERC-20 path makes. It was missing here, which
        // made batch:false the one degraded mode that did not declare itself
        // — and a caller reading `batched` alone has no warning to weigh.
        warnings.push(
          "batch:false read these one call at a time, so the balances are not guaranteed to be from the same block",
        );
      }
      if (batch && blockNumber === null) warnings.push(NO_BLOCK_NUMBER);
      if (spender !== null) {
        warnings.push("the native currency has no allowance; spender was ignored");
      }
      return json({
        chainId: input.chainId,
        blockTag,
        blockNumber,
        batched: batch,
        token: { kind: "native", address: null, decimals },
        balances,
        warnings,
      });
    }

    const token = await requireAddress(input.token, "token");
    const code =
      (input.checkCode ?? true) ? await readHasCode(input.chainId, token, blockTag) : null;
    if (code !== null && !code.hasCode) {
      throw new TokenError(
        `there is no contract at ${token} at block ${blockTag}. Every call to it answers 0x, which decodes as a zero balance for every account and an empty symbol — this is not a token. Pass checkCode:false only if you know the node cannot answer eth_getCode.`,
      );
    }

    const calls: BatchCall[] = erc20MetadataCalls("t:", token);
    for (const [i, account] of accounts.entries()) {
      calls.push({
        key: `b${i}`,
        target: token,
        callData: callData(SELECTOR.balanceOf, addressWord(account.checksummed)),
      });
      if (spender !== null) {
        calls.push({
          key: `a${i}`,
          target: token,
          callData: callData(
            SELECTOR.allowance,
            addressWord(account.checksummed),
            addressWord(spender),
          ),
        });
      }
    }

    const read = await readCalls({
      chainId: input.chainId,
      calls,
      blockTag,
      batch,
      multicall3Address: multicall,
    });
    const facts = erc20Facts("t:", read.outcomes);

    const balances: Array<Record<string, unknown>> = [];
    for (const [i, account] of accounts.entries()) {
      const outcome = read.outcomes.get(`b${i}`);
      const raw = uintField(outcome);
      const row: Record<string, unknown> = {
        account: account.checksummed,
        raw: raw === null ? null : raw.toString(),
        decimal: raw === null ? null : await scaled(raw, facts.decimals),
      };
      if (raw === null) {
        row["error"] =
          `balanceOf reverted or returned nothing: ${outcome?.revert?.reason ?? outcome?.revert?.kind ?? outcome?.error ?? "no data"}`;
      }
      if (spender !== null) {
        const allowanceRaw = uintField(read.outcomes.get(`a${i}`));
        row["allowance"] =
          allowanceRaw === null
            ? { raw: null, decimal: null, error: "allowance reverted or returned nothing" }
            : {
                spender,
                raw: allowanceRaw.toString(),
                decimal: await scaled(allowanceRaw, facts.decimals),
                // 2^256-1 is what "infinite approval" is spelled as, and it
                // is worth naming: it is not a large allowance, it is all of
                // them, for as long as the approval stands.
                unlimited: allowanceRaw === (1n << 256n) - 1n,
              };
      }
      balances.push(row);
    }

    const warnings = metadataWarnings(facts);
    if (!batch) {
      warnings.push(
        "batch:false read these one call at a time, so the balances and the decimals are not guaranteed to be from the same block",
      );
    }
    if (read.batched && read.blockNumber === null) warnings.push(NO_BLOCK_NUMBER);
    return json({
      chainId: input.chainId,
      blockTag,
      blockNumber: read.blockNumber,
      batched: read.batched,
      token: {
        kind: "erc20",
        address: token,
        hasCode: code?.hasCode ?? null,
        decimals: facts.decimals,
        symbol: facts.symbol,
        name: facts.name,
        totalSupply: facts.totalSupply,
      },
      balances,
      warnings,
    });
  },
});

// ---------------------------------------------------------------------------
// Erc721TokenInfo
// ---------------------------------------------------------------------------

const INTERFACE_KEYS = {
  erc165: "i165",
  invalid: "iBad",
  erc721: "i721",
  erc721Metadata: "i721m",
  erc1155: "i1155",
  erc1155MetadataUri: "i1155m",
} as const;

export const erc721TokenInfo: RegisteredTool = buildTool({
  name: "Erc721TokenInfo",
  operativeArgs: [
    { field: "contract", kind: "id", within: "chainId" },
    { field: "ipfsGateway", kind: "url" },
  ],
  description:
    "Read one NFT: which standard the contract actually implements, the collection's name and symbol, who owns the token (or an ERC-1155 holder's balance of it), and its tokenURI. Use it to check what an NFT is before buying, listing or transferring it. Metadata is read ONLY when it costs no trust: a data: URI is decoded in-process, an ipfs: URI is fetched through a gateway YOU named, and an https: URI only from a host YOU allow-listed — a URL that came out of contract data is not a reason to dial it, and following one is a server-side request forgery with extra steps. The answer lists every URI it read and every one it skipped, with the reason. ERC-1155's {id} placeholder is substituted with the 64-hex-digit zero-padded form the spec requires and almost everyone gets wrong, ERC-1155 has no ownerOf so ownership is answered as a balance or not at all rather than as a misleading null, and a contract that claims to support the invalid interface id is reported as one whose supportsInterface answers mean nothing.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      contract: z.string().min(1).describe("the NFT contract address"),
      tokenId: z
        .string()
        .min(1)
        .max(80)
        .describe(
          "the token id, decimal or 0x hex — a string, because a uint256 is not a JS number",
        ),
      owner: z
        .string()
        .optional()
        .describe(
          "an account to read the ERC-1155 balance of, or to check an ERC-721 owner against",
        ),
      standard: z
        .enum(["auto", "erc721", "erc1155"])
        .optional()
        .describe("auto (default) asks the contract through ERC-165"),
      fetchMetadata: z
        .boolean()
        .optional()
        .describe("read the metadata document when policy allows it; default true"),
      ipfsGateway: z
        .string()
        .optional()
        .describe(
          'a URL PREFIX such as "https://cloudflare-ipfs.com/ipfs/"; without it, ipfs URIs are skipped',
        ),
      allowedHosts: z
        .array(z.string().min(1))
        .max(LIMITS.hosts)
        .optional()
        .describe(
          "hosts an https metadata URI may be fetched from; without it, https URIs are skipped",
        ),
      maxMetadataBytes: z
        .number()
        .int()
        .positive()
        .max(4 * 1024 * 1024)
        .optional()
        .describe(`cap on the metadata document; default ${DEFAULT_MAX_METADATA_BYTES}`),
      checkCode: z.boolean().optional(),
      blockTag: blockTagField,
      batch: batchField,
      multicall3Address: multicallField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const blockTag = input.blockTag ?? "latest";
    const contract = await requireAddress(input.contract, "contract");
    const owner = input.owner === undefined ? null : await requireAddress(input.owner, "owner");
    const maxBytes = input.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;

    let tokenId: bigint;
    try {
      const text = input.tokenId.trim();
      if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) throw new Error("not an integer");
      tokenId = BigInt(text);
      padTokenIdHex(tokenId);
    } catch {
      throw new TokenError(
        `"${input.tokenId}" is not a token id; give a decimal or 0x hex uint256 as a string`,
      );
    }

    const code =
      (input.checkCode ?? true) ? await readHasCode(input.chainId, contract, blockTag) : null;
    if (code !== null && !code.hasCode) {
      throw new TokenError(
        `there is no contract at ${contract} at block ${blockTag} — every call to it answers 0x, so an NFT read against it would report no owner and no URI rather than saying this is not a contract`,
      );
    }

    const supports = (key: string, id: string): BatchCall => ({
      key,
      target: contract,
      callData: callData(SELECTOR.supportsInterface, bytes4Word(id)),
    });
    const idWord = uintWord(tokenId);
    const calls: BatchCall[] = [
      supports(INTERFACE_KEYS.erc165, INTERFACE_ID.erc165),
      supports(INTERFACE_KEYS.invalid, INTERFACE_ID.invalid),
      supports(INTERFACE_KEYS.erc721, INTERFACE_ID.erc721),
      supports(INTERFACE_KEYS.erc721Metadata, INTERFACE_ID.erc721Metadata),
      supports(INTERFACE_KEYS.erc1155, INTERFACE_ID.erc1155),
      supports(INTERFACE_KEYS.erc1155MetadataUri, INTERFACE_ID.erc1155MetadataUri),
      { key: "name", target: contract, callData: callData(SELECTOR.name) },
      { key: "symbol", target: contract, callData: callData(SELECTOR.symbol) },
      { key: "ownerOf", target: contract, callData: callData(SELECTOR.ownerOf, idWord) },
      { key: "tokenURI", target: contract, callData: callData(SELECTOR.tokenURI, idWord) },
      { key: "uri", target: contract, callData: callData(SELECTOR.uri, idWord) },
    ];
    if (owner !== null) {
      calls.push({
        key: "balance1155",
        target: contract,
        callData: callData(SELECTOR.balanceOf1155, addressWord(owner), idWord),
      });
    }

    const read = await readCalls({
      chainId: input.chainId,
      calls,
      blockTag,
      batch: input.batch ?? true,
      ...(input.multicall3Address !== undefined
        ? { multicall3Address: input.multicall3Address }
        : {}),
    });

    const says = (key: string): boolean | null => {
      const outcome = read.outcomes.get(key);
      if (outcome === undefined || !outcome.ok) return null;
      return decodeBool(outcome.data);
    };
    const interfaces = {
      erc165: says(INTERFACE_KEYS.erc165),
      erc721: says(INTERFACE_KEYS.erc721),
      erc721Metadata: says(INTERFACE_KEYS.erc721Metadata),
      erc1155: says(INTERFACE_KEYS.erc1155),
      erc1155MetadataUri: says(INTERFACE_KEYS.erc1155MetadataUri),
      /** ERC-165 requires this to be false. True means every other answer is worthless. */
      claimsInvalidInterface: says(INTERFACE_KEYS.invalid) === true,
    };

    const flags: string[] = [];
    if (interfaces.claimsInvalidInterface) {
      flags.push(
        "bogus-erc165: the contract answers true for the invalid interface id 0xffffffff, which ERC-165 requires to be false — it answers true to everything, so its other interface answers mean nothing",
      );
    }
    const trustInterfaces = !interfaces.claimsInvalidInterface;

    const ownerOfOutcome = read.outcomes.get("ownerOf");
    const ownerOfValue =
      ownerOfOutcome?.ok === true ? decodeAddressValue(ownerOfOutcome.data) : null;
    const uriRead = textField(read.outcomes.get("uri"));
    const tokenUriRead = textField(read.outcomes.get("tokenURI"));

    let standard: "erc721" | "erc1155" | "unknown";
    let standardSource: string;
    if (input.standard !== undefined && input.standard !== "auto") {
      standard = input.standard;
      standardSource = "declared by the caller";
      const contradicted =
        (standard === "erc721" && interfaces.erc1155 === true && interfaces.erc721 !== true) ||
        (standard === "erc1155" && interfaces.erc721 === true && interfaces.erc1155 !== true);
      if (trustInterfaces && contradicted) {
        flags.push(`standard-disagreement: you declared ${standard}, ERC-165 says otherwise`);
      }
    } else if (trustInterfaces && interfaces.erc721 === true) {
      standard = "erc721";
      standardSource = "erc165";
    } else if (trustInterfaces && interfaces.erc1155 === true) {
      standard = "erc1155";
      standardSource = "erc165";
    } else if (ownerOfValue !== null) {
      standard = "erc721";
      standardSource = "inferred: ownerOf answered, which ERC-1155 has no equivalent of";
      flags.push("no-erc165: the contract did not declare ERC-721 through supportsInterface");
    } else if (uriRead.value !== null) {
      standard = "erc1155";
      standardSource = "inferred: uri(uint256) answered";
      flags.push("no-erc165: the contract did not declare ERC-1155 through supportsInterface");
    } else {
      standard = "unknown";
      standardSource = "nothing the contract answered identifies it";
      flags.push("unknown-standard");
    }

    // ERC-1155 has no ownerOf: one id is held by many addresses at once, so
    // ownership is a balance or it is not answerable. Returning null would
    // read as "nobody owns it".
    let ownership: Record<string, unknown>;
    if (standard === "erc1155") {
      const balanceOutcome = read.outcomes.get("balance1155");
      const balance = uintField(balanceOutcome);
      if (owner === null) {
        ownership = {
          kind: "erc1155",
          answerable: false,
          reason:
            "ERC-1155 has no ownerOf — a token id is held by many addresses at once. Pass owner to read balanceOf(owner, id).",
        };
      } else if (balance === null) {
        // The same rule as the missing owner above, one call along: a null
        // under a named account reads as "this account holds none of it",
        // which is the answer a listing check would act on. The call not
        // answering is a different fact and says so.
        ownership = {
          kind: "erc1155",
          account: owner,
          answerable: false,
          balance: null,
          reason: `balanceOf(${owner}, ${tokenId}) did not answer: ${balanceOutcome?.revert?.reason ?? balanceOutcome?.revert?.kind ?? balanceOutcome?.error ?? "no data"} — this is not a balance of zero`,
        };
        flags.push("balance-unreadable");
      } else {
        ownership = { kind: "erc1155", account: owner, balance: balance.toString() };
      }
    } else {
      const checked = ownerOfValue === null ? null : (await checkAddress(ownerOfValue)).checksummed;
      ownership = {
        // "unknown" rather than "erc721" when nothing identified the contract:
        // a null owner under an erc721 label reads as "this NFT has no owner"
        // instead of "this may not be an NFT".
        kind: standard,
        owner: checked,
        matchesOwnerArgument: owner === null || checked === null ? null : checked === owner,
        reason:
          checked === null
            ? `ownerOf(${tokenId}) did not answer: ${ownerOfOutcome?.revert?.reason ?? ownerOfOutcome?.revert?.kind ?? ownerOfOutcome?.error ?? "no data"} — the token may never have been minted, or may have been burned`
            : "",
      };
      if (checked === null) flags.push("owner-unreadable");
    }

    // Prefer the standard's own call, and fall back to the other one rather
    // than reporting no URI for a contract that answered the wrong question.
    const primary = standard === "erc1155" ? uriRead : tokenUriRead;
    const fallback = standard === "erc1155" ? tokenUriRead : uriRead;
    const rawUri = primary.value ?? fallback.value;
    const uriSource =
      primary.value !== null
        ? standard === "erc1155"
          ? "uri(uint256)"
          : "tokenURI(uint256)"
        : fallback.value !== null
          ? standard === "erc1155"
            ? "tokenURI(uint256)"
            : "uri(uint256)"
          : "none";

    // The {id} placeholder is 64 lowercase hex digits, zero-padded, with no
    // 0x. Substituting the decimal id returns a 404 or, worse, somebody
    // else's metadata.
    const substituted = rawUri === null ? null : rawUri.replaceAll("{id}", padTokenIdHex(tokenId));

    let plan: UriPlan | null = null;
    let metadata: Record<string, unknown> = { attempted: false, reason: "no URI to read" };

    if (substituted !== null) {
      try {
        plan = planUri(substituted, {
          ...(input.ipfsGateway !== undefined ? { ipfsGateway: input.ipfsGateway } : {}),
          ...(input.allowedHosts !== undefined ? { allowedHosts: input.allowedHosts } : {}),
        });
      } catch (err) {
        throw new TokenError((err as Error).message);
      }
      if (input.fetchMetadata === false) {
        metadata = { attempted: false, reason: "fetchMetadata was false" };
      } else if (plan.action === "skip") {
        metadata = { attempted: false, reason: plan.reason };
      } else {
        try {
          const bytes =
            plan.action === "inline"
              ? decodeDataUri(substituted, maxBytes)
              : (await fetchDocument(plan.url, maxBytes, ctx?.signal)).bytes;
          let parsed: unknown = null;
          let parseError: string | null = null;
          try {
            parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch (err) {
            parseError = (err as Error).message;
          }
          metadata = {
            attempted: true,
            fetched: true,
            source: plan.action === "inline" ? "data:" : plan.url,
            bytes: bytes.length,
            sha256: sha256(bytes),
            json: parsed,
            parseError,
            // Third-party content, which is why it is reported rather than
            // merged into the answer's own fields.
            untrusted:
              "this document came from whoever deployed the contract; nothing in it was verified",
            referencedUrls: referencedUrls(parsed) as ReadonlyArray<ReferencedUrl>,
            referencedUrlsNote:
              "listed, never fetched — an image URL is the same untrusted string one level deeper",
          };
        } catch (err) {
          metadata = { attempted: true, fetched: false, reason: (err as Error).message };
        }
      }
    }

    return json({
      chainId: input.chainId,
      contract,
      tokenId: tokenId.toString(),
      blockTag,
      blockNumber: read.blockNumber,
      batched: read.batched,
      standard,
      standardSource,
      interfaces,
      collection: {
        name: textField(read.outcomes.get("name")),
        symbol: textField(read.outcomes.get("symbol")),
      },
      ownership,
      tokenUri: {
        source: uriSource,
        raw: rawUri,
        substituted,
        idPlaceholderSubstituted: rawUri?.includes("{id}") ?? false,
        plan,
      },
      // What was read and what was skipped, both: `tokenUri.plan` is the
      // decision and `metadata` is what came of it. The reason is not repeated
      // a third time, because every byte returned is a byte in somebody's
      // context window.
      metadata,
      flags,
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const TOKEN_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  erc20Balance,
  erc721TokenInfo,
  tokenResolve,
]);
