/**
 * Turning one transaction into bookkeeping: what moved, who paid, and — the
 * part most summaries get wrong — what is not visible from here at all.
 *
 * A receipt contains logs and nothing else. Native value that a CONTRACT sent
 * during the call leaves no log; it is only visible in a trace, and
 * `debug_traceTransaction` is not on any public endpoint's free tier and is not
 * on this package's read-only allow-list. So the summary reports the top-level
 * `value` and says, in the output and not only in the README, that internal
 * transfers are excluded. A net delta that claims to be complete and is not is
 * worse than no net delta: it reconciles.
 *
 * The event topics below are constants because computing them needs Keccak and
 * this package has no hasher of its own. They are not TRUSTED as constants —
 * `lib.test.ts` recomputes every one of them with `FunctionSelector` from
 * `@crewhaus/tool-onchain` and fails if a digit is off. A mistyped topic is a
 * filter that silently matches nothing, which is the same failure as a missing
 * log.
 */
import type { RawLog } from "./logs";
import { ChainReadError, field, hexToBigint, lowerHex, optionalHexToBigint } from "./quantity";

/** `Transfer(address,address,uint256)` — ERC-20 and ERC-721 share it. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** `Approval(address,address,uint256)`. */
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
/** `ApprovalForAll(address,address,bool)` — the blanket ERC-721/1155 approval. */
export const APPROVAL_FOR_ALL_TOPIC =
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
/** `TransferSingle(address,address,address,uint256,uint256)` — ERC-1155. */
export const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

/** The signatures the constants above are the Keccak of, so the test can recompute them. */
export const TOPIC_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
  [TRANSFER_TOPIC]: "Transfer(address,address,uint256)",
  [APPROVAL_TOPIC]: "Approval(address,address,uint256)",
  [APPROVAL_FOR_ALL_TOPIC]: "ApprovalForAll(address,address,bool)",
  [TRANSFER_SINGLE_TOPIC]: "TransferSingle(address,address,address,uint256,uint256)",
});

/** The low 20 bytes of a 32-byte topic word, which is how an indexed address is stored. */
export function topicToAddress(topic: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new ChainReadError(`expected a 32-byte topic, got "${topic}"`);
  }
  return `0x${topic.slice(26).toLowerCase()}`;
}

export type TokenMovement = {
  readonly standard: "erc20" | "erc721" | "erc1155";
  readonly token: string;
  readonly from: string;
  readonly to: string;
  /** Base units for ERC-20, the token id for ERC-721. Always a decimal string. */
  readonly amount: string;
  readonly tokenId?: string;
  readonly logIndex: number;
};

export type ApprovalEvent = {
  readonly kind: "approval" | "approvalForAll";
  readonly token: string;
  readonly owner: string;
  readonly spender: string;
  /** For `approval`: the allowance in base units. `unlimited` marks the max-uint256 pattern. */
  readonly amount?: string;
  readonly unlimited?: boolean;
  readonly approved?: boolean;
  readonly logIndex: number;
};

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * An ERC-20 transfer and an ERC-721 transfer are the same event with different
 * indexing: the token id is indexed, the amount is not. So three topics means
 * fungible and four means a specific NFT — the only signal there is, and
 * reading a token id as an amount is how an NFT becomes "1e-18 of a token".
 */
export function decodeTransfer(log: RawLog): TokenMovement | null {
  const [topic0, from, to, third] = log.topics;
  if (topic0 === TRANSFER_TOPIC && from !== undefined && to !== undefined) {
    if (third !== undefined) {
      return {
        standard: "erc721",
        token: log.address,
        from: topicToAddress(from),
        to: topicToAddress(to),
        amount: "1",
        tokenId: BigInt(third).toString(),
        logIndex: log.logIndex,
      };
    }
    return {
      standard: "erc20",
      token: log.address,
      from: topicToAddress(from),
      to: topicToAddress(to),
      amount: dataWord(log.data, 0, "Transfer value").toString(),
      logIndex: log.logIndex,
    };
  }

  const [, operator, sender, recipient] = log.topics;
  if (
    topic0 === TRANSFER_SINGLE_TOPIC &&
    operator !== undefined &&
    sender !== undefined &&
    recipient !== undefined
  ) {
    return {
      standard: "erc1155",
      token: log.address,
      from: topicToAddress(sender),
      to: topicToAddress(recipient),
      amount: dataWord(log.data, 1, "TransferSingle value").toString(),
      tokenId: dataWord(log.data, 0, "TransferSingle id").toString(),
      logIndex: log.logIndex,
    };
  }
  return null;
}

export function decodeApproval(log: RawLog): ApprovalEvent | null {
  const [topic0, owner, spender, third] = log.topics;
  if (owner === undefined || spender === undefined) return null;

  if (topic0 === APPROVAL_TOPIC && third === undefined) {
    const amount = dataWord(log.data, 0, "Approval value");
    return {
      kind: "approval",
      token: log.address,
      owner: topicToAddress(owner),
      spender: topicToAddress(spender),
      amount: amount.toString(),
      // The infinite-allowance pattern. Worth flagging on its own: it is the
      // difference between "approved 100 USDC" and "approved the balance,
      // forever".
      unlimited: amount === MAX_UINT256,
      logIndex: log.logIndex,
    };
  }
  if (topic0 === APPROVAL_FOR_ALL_TOPIC) {
    return {
      kind: "approvalForAll",
      token: log.address,
      owner: topicToAddress(owner),
      spender: topicToAddress(spender),
      approved: dataWord(log.data, 0, "ApprovalForAll approved") !== 0n,
      logIndex: log.logIndex,
    };
  }
  return null;
}

function dataWord(data: string, index: number, what: string): bigint {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const start = index * 64;
  const word = body.slice(start, start + 64);
  if (word.length < 64) {
    throw new ChainReadError(
      `${what}: the log's data has ${body.length / 2} bytes, too few to hold word ${index} — this is not the event it claims to be`,
    );
  }
  return BigInt(`0x${word}`);
}

// ---------------------------------------------------------------------------
// transactions, receipts and what they cost
// ---------------------------------------------------------------------------

export type TransactionView = {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly nonce: string;
  readonly input: string;
  readonly selector: string | null;
  readonly gas: string | null;
  readonly gasPrice: string | null;
  readonly maxFeePerGas: string | null;
  readonly maxPriorityFeePerGas: string | null;
  readonly type: string | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly contractCreation: boolean;
};

export function projectTransaction(raw: Record<string, unknown>): TransactionView {
  const input = typeof raw["input"] === "string" ? lowerHex(raw["input"], "tx input") : "0x";
  const to = typeof raw["to"] === "string" ? lowerHex(raw["to"], "tx to") : null;
  const blockNumber = optionalHexToBigint(raw["blockNumber"], "tx blockNumber");
  return {
    hash: lowerHex(raw["hash"], "tx hash"),
    from: lowerHex(raw["from"], "tx from"),
    to,
    value: hexToBigint(raw["value"], "tx value").toString(),
    nonce: hexToBigint(raw["nonce"], "tx nonce").toString(),
    input,
    // Four bytes is a call; anything shorter is a plain transfer or a
    // contract creation, and slicing it anyway would invent a selector.
    selector: input.length >= 10 ? input.slice(0, 10) : null,
    gas: optionalHexToBigint(raw["gas"], "tx gas")?.toString() ?? null,
    gasPrice: optionalHexToBigint(raw["gasPrice"], "tx gasPrice")?.toString() ?? null,
    maxFeePerGas: optionalHexToBigint(raw["maxFeePerGas"], "maxFeePerGas")?.toString() ?? null,
    maxPriorityFeePerGas:
      optionalHexToBigint(raw["maxPriorityFeePerGas"], "maxPriorityFeePerGas")?.toString() ?? null,
    type: typeof raw["type"] === "string" ? raw["type"] : null,
    blockNumber: blockNumber === null ? null : blockNumber.toString(),
    blockHash:
      typeof raw["blockHash"] === "string" ? lowerHex(raw["blockHash"], "blockHash") : null,
    contractCreation: to === null,
  };
}

/**
 * What a receipt says happened.
 *
 * `status` has three values here, not two. `0x1` and `0x0` are the chain's
 * answer; `unknown` is for a pre-Byzantium receipt, which carries a state
 * `root` instead of a status and simply does not record whether the call
 * reverted. Mapping that third case onto "failed" would invent a revert, and
 * onto "succeeded" would hide one.
 */
export type ReceiptView = {
  readonly status: "success" | "reverted" | "unknown";
  readonly statusReason?: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionIndex: number | null;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string | null;
  readonly contractAddress: string | null;
  readonly logs: ReadonlyArray<RawLog>;
};

export function projectReceipt(
  raw: Record<string, unknown>,
  projectLog: (value: unknown) => RawLog,
): ReceiptView {
  const status = raw["status"];
  const logs = Array.isArray(raw["logs"]) ? raw["logs"].map(projectLog) : [];
  const decided: ReceiptView["status"] =
    status === "0x1" || status === "0x01"
      ? "success"
      : status === "0x0" || status === "0x00"
        ? "reverted"
        : "unknown";
  return {
    status: decided,
    ...(decided === "unknown"
      ? {
          statusReason:
            raw["root"] === undefined
              ? `the receipt carries no status field (got ${JSON.stringify(status)})`
              : "this is a pre-Byzantium receipt: it carries a state root instead of a status, so whether the call reverted is not recorded",
        }
      : {}),
    blockNumber: hexToBigint(raw["blockNumber"], "receipt blockNumber").toString(),
    blockHash: lowerHex(raw["blockHash"], "receipt blockHash"),
    transactionIndex:
      raw["transactionIndex"] === undefined
        ? null
        : Number(hexToBigint(raw["transactionIndex"], "receipt transactionIndex")),
    gasUsed: hexToBigint(raw["gasUsed"], "receipt gasUsed").toString(),
    effectiveGasPrice:
      optionalHexToBigint(raw["effectiveGasPrice"], "effectiveGasPrice")?.toString() ?? null,
    contractAddress:
      typeof raw["contractAddress"] === "string"
        ? lowerHex(raw["contractAddress"], "contractAddress")
        : null,
    logs,
  };
}

export type FeeBreakdown = {
  /** Which chain family's fee arithmetic was applied, inferred from the receipt's own fields. */
  readonly model: "eip1559" | "op-stack" | "arbitrum" | "unknown";
  readonly gasUsed: string;
  readonly effectiveGasPrice: string | null;
  readonly executionFeeWei: string | null;
  /** The OP-stack L1 data fee, which is a separate charge and is NOT in gasUsed. */
  readonly l1FeeWei: string | null;
  readonly totalFeeWei: string | null;
  readonly note: string;
};

/**
 * `gasUsed * effectiveGasPrice` is the whole fee on L1 and is WRONG on a
 * rollup, in two different directions.
 *
 * OP-stack chains charge a separate L1 data fee that appears as `l1Fee` on the
 * receipt and is not included in `gasUsed`; leaving it out understates the cost
 * of a Base or Optimism transaction by most of the cost. Arbitrum folds its L1
 * component INTO `gasUsed` and reports the share as `gasUsedForL1`, so the
 * simple product is right there and adding anything would double-count.
 *
 * Both are detected from fields the receipt either has or does not, rather than
 * from a chain id table that goes stale every time a new rollup ships.
 */
export function feeBreakdown(receipt: Record<string, unknown>, view: ReceiptView): FeeBreakdown {
  const gasUsed = BigInt(view.gasUsed);
  const price = view.effectiveGasPrice === null ? null : BigInt(view.effectiveGasPrice);
  const execution = price === null ? null : gasUsed * price;
  const l1Fee = optionalHexToBigint(field(receipt, "l1Fee"), "l1Fee");
  const gasUsedForL1 = optionalHexToBigint(field(receipt, "gasUsedForL1"), "gasUsedForL1");

  if (l1Fee !== null) {
    return {
      model: "op-stack",
      gasUsed: view.gasUsed,
      effectiveGasPrice: view.effectiveGasPrice,
      executionFeeWei: execution?.toString() ?? null,
      l1FeeWei: l1Fee.toString(),
      totalFeeWei: execution === null ? null : (execution + l1Fee).toString(),
      note: "OP-stack: the L1 data fee is charged separately from gas, so the total is execution + l1Fee",
    };
  }
  if (gasUsedForL1 !== null) {
    return {
      model: "arbitrum",
      gasUsed: view.gasUsed,
      effectiveGasPrice: view.effectiveGasPrice,
      executionFeeWei: execution?.toString() ?? null,
      l1FeeWei: null,
      totalFeeWei: execution?.toString() ?? null,
      note: `Arbitrum: gasUsed already includes the ${gasUsedForL1} gas charged for L1 data, so the total is the single product`,
    };
  }
  return {
    model: price === null ? "unknown" : "eip1559",
    gasUsed: view.gasUsed,
    effectiveGasPrice: view.effectiveGasPrice,
    executionFeeWei: execution?.toString() ?? null,
    l1FeeWei: null,
    totalFeeWei: execution?.toString() ?? null,
    note:
      price === null
        ? "this receipt carries no effectiveGasPrice, so the fee cannot be computed from it"
        : "gasUsed * effectiveGasPrice; no rollup fee fields were present on this receipt",
  };
}
