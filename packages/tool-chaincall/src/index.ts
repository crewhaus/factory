/**
 * @crewhaus/tool-chaincall — ask a contract what it knows, and what a call
 * would cost.
 *
 * Four read-only questions that each take more than one round trip to answer
 * properly, and that a model gets plausibly wrong when it answers them by
 * reasoning instead of by reading:
 *
 *   - **EvmMulticall** — a hundred view calls at ONE block height, so the
 *     answers are consistent with each other.
 *   - **ContractInspect** — is there code here, is it a proxy, and what does
 *     it claim to implement.
 *   - **EvmSimulateBundle** — what would this ordered sequence of calls do,
 *     and honest degradation when the node cannot answer that question.
 *   - **GasMarketRead** — what the fee market is doing, and which fee market
 *     this chain actually runs.
 *
 * **Nothing here signs or sends.** No schema has a field to pass a private
 * key, a mnemonic or a signed transaction to; every JSON-RPC method goes
 * through `chain-adapter-base`'s read-only allowlist at the single dispatch
 * point in `./lib/rpc`; and `index.test.ts` asserts both, by walking the
 * schemas and by recording every method the tools dispatch. Simulating a
 * transaction is a read — the node evaluates it and throws the result away.
 * Submitting one is not, and there is no path to it from here.
 *
 * Two rules run through all four:
 *
 *   1. **A wrong answer is worse than no answer.** A batch result the tool
 *      cannot line up with the calls that produced it is refused, not
 *      zipped. A proxy with two implementations is unresolved, not
 *      arbitrated. A bundle simulated without state chaining omits its
 *      effects entirely rather than reporting the computable half.
 *   2. **No chain quantity is ever a JS number.** Wei, balances, gas and
 *      block numbers are `bigint` in memory and decimal strings on the way
 *      out. A uint256 is 78 digits; a double carries 15, and loses the
 *      difference silently.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import {
  MULTICALL3_ADDRESS,
  decodeAggregate3,
  decodeRevertData,
  encodeAggregate3,
} from "@crewhaus/tool-onchain";
import { z } from "zod";
import { type Call3, chunk, runAggregate3 } from "./lib/batch";
import {
  SELECTORS,
  balanceOfData,
  checkAddress,
  decodeValues,
  encodeCallData,
  getEthBalanceData,
  supportsInterfaceData,
} from "./lib/codec";
import { changeBps, nextBaseFee, summarisePercentile } from "./lib/fees";
import {
  ZERO_ADDRESS,
  data as asData,
  blockParam,
  byteLength,
  isZeroWord,
  optionalQuantity,
  quantity,
  toQuantity,
  wordAt,
  wordToAddress,
  wordToBigint,
  wordToBool,
} from "./lib/hex";
import {
  DIAMOND_LOUPE_ID,
  EIP1822_SLOT,
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  ERC165_INVALID_ID,
  KNOWN_INTERFACES,
  type ProxySignal,
  minimalProxyTarget,
  reconcileProxy,
} from "./lib/proxy";
import {
  ChainCallError,
  type ChainRpc,
  isAbort,
  isMethodUnsupported,
  resolveRpc,
  rpcError,
  rpcErrorText,
  rpcRead,
  startDeadline,
} from "./lib/rpc";
import {
  FALLBACK_LIMITATIONS,
  type SimCallResult,
  parseSimulateV1,
  revertFromCallError,
  toWireCall,
  unchainedLimitation,
} from "./lib/simulate";

export {
  ChainCallError,
  type ChainRpc,
  type ChainRpcResolver,
  _setRpc,
  bindChainCallChains,
  chainRpcFromAdapter,
  setChainRpcResolver,
} from "./lib/rpc";
export { MULTICALL3_ADDRESS } from "@crewhaus/tool-onchain";
export {
  EIP1822_SLOT,
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  ERC165_INVALID_ID,
  KNOWN_INTERFACES,
} from "./lib/proxy";

const json = (value: unknown): string => JSON.stringify(value);

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ceilings. Each exists because passing it turns a read into something else:
 * a crawl, a request body a provider drops, or a batch past a node's gas cap.
 */
const LIMITS = {
  calls: 512,
  batchSize: 64,
  maxBatchSize: 256,
  bundleCalls: 64,
  interfaceProbes: 32,
  feeBlocks: 100,
  trackedAccounts: 16,
  trackedTokens: 8,
} as const;

/**
 * Pillar 3 sink-side: these cross a network boundary, so they say so. The
 * destination is whatever the operator wired into `spec.chains[]` — no
 * caller supplies a URL anywhere in this package — but "it is the operator's
 * endpoint" is not a reason to hide that bytes leave the process.
 */
const NETWORK_TOOL = {
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
} as const;

const chainIdField = z.string().min(1).describe("id of the chain, from spec.chains[]");

const blockNumberField = z
  .string()
  .regex(/^\d+$/)
  .optional()
  .describe("an exact block number as a DECIMAL string; overrides blockTag");

const blockTagField = z
  .enum(["latest", "safe", "finalized", "pending", "earliest"])
  .optional()
  .describe("default latest");

const timeoutField = z
  .number()
  .int()
  .min(1_000)
  .max(120_000)
  .optional()
  .describe(`deadline for the whole call in ms; default ${DEFAULT_TIMEOUT_MS}`);

const multicallAddressField = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .optional()
  .describe(`Multicall3 on this chain; default ${MULTICALL3_ADDRESS}`);

type BlockChoice = { readonly blockNumber?: string; readonly blockTag?: string };

/** The block parameter, and whether the caller pinned it themselves. */
function blockOf(input: BlockChoice): { param: string; pinnedByCaller: boolean } {
  return {
    param: blockParam(input.blockNumber, input.blockTag),
    pinnedByCaller: input.blockNumber !== undefined,
  };
}

/** A 32-byte word from a storage read, normalised: nodes pad differently. */
function storageWord(raw: unknown, what: string): string {
  const value = quantity(raw, what);
  return `0x${value.toString(16).padStart(64, "0")}`;
}

// ---------------------------------------------------------------------------
// EvmMulticall
// ---------------------------------------------------------------------------

const multicallCall = z
  .object({
    target: z.string().min(1).describe("the contract to call"),
    data: z.string().optional().describe("pre-encoded calldata, 0x hex (from AbiEncodeCall)"),
    signature: z.string().optional().describe("e.g. balanceOf(address) — encoded here instead"),
    args: z.array(z.unknown()).max(64).optional().describe("arguments for `signature`"),
    outputs: z
      .array(z.string())
      .max(32)
      .optional()
      .describe('ABI types to decode the result with, e.g. ["uint256"]'),
    allowFailure: z
      .boolean()
      .optional()
      .describe("default true: this call reverting is a row, not a batch failure"),
    label: z.string().max(80).optional().describe("carried into the result row"),
  })
  .strict();

type MulticallCallInput = z.infer<typeof multicallCall>;

/** Build one sub-call's calldata, refusing the two ambiguous input shapes. */
async function calldataFor(call: MulticallCallInput, index: number): Promise<string> {
  const hasData = call.data !== undefined;
  const hasSignature = call.signature !== undefined;
  if (hasData && hasSignature) {
    throw new ChainCallError(
      `calls[${index}] gives both data and signature — they would encode to different calldata and there is no way to tell which one was meant`,
    );
  }
  if (hasData) return asData(call.data, `calls[${index}].data`);
  if (hasSignature) {
    return encodeCallData(
      call.signature as string,
      call.args ?? [],
      `calls[${index}] (${call.signature})`,
    );
  }
  throw new ChainCallError(
    `calls[${index}] has neither data nor signature — give one of them (data for calldata you already have, signature+args to encode it here)`,
  );
}

export const evmMulticall: RegisteredTool = buildTool({
  name: "EvmMulticall",
  description:
    "Run many view calls against a chain in one request through Multicall3, returning one decoded row per call at a SINGLE block height. Use it for any question that reads more than one contract — a hundred balances, a token's whole metadata, a pool's reserves plus its fee — because a hundred separate reads land at a hundred different block heights and the answers do not add up. A sub-call that reverts is a row with its revert reason, not a failed request, so one bad token does not lose the other ninety-nine. When a batch is too large for one request it is split, and the block is PINNED from the first batch so every row still answers at the same height. A call that succeeds with empty return data is flagged rather than decoded: in the EVM, calling an address with no code succeeds and returns nothing, which is how a missing contract becomes a zero balance. It reads only, and nothing here signs or submits anything.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      calls: z.array(multicallCall).min(1).max(LIMITS.calls),
      blockNumber: blockNumberField,
      blockTag: blockTagField,
      multicall3Address: multicallAddressField,
      batchSize: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.maxBatchSize)
        .optional()
        .describe(`calls per eth_call; default ${LIMITS.batchSize}`),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const rpc = resolveRpc(input.chainId, "EvmMulticall");
      const multicall3 = input.multicall3Address ?? MULTICALL3_ADDRESS;
      const { param, pinnedByCaller } = blockOf(input);

      const calls: Call3[] = [];
      for (const [index, call] of input.calls.entries()) {
        calls.push({
          target: call.target,
          callData: await calldataFor(call, index),
          allowFailure: call.allowFailure ?? true,
        });
      }

      const size = input.batchSize ?? LIMITS.batchSize;
      const batches = chunk(calls, size);
      const first = batches[0] as Call3[];

      // The block probe: Multicall3 calling ITSELF for `getBlockNumber()`,
      // riding in the first batch. One extra slot instead of an extra
      // round trip, and — unlike asking eth_blockNumber first — the number
      // it returns is the block this batch actually executed at, so there
      // is no window in which the head moves between the two reads.
      const probing = !pinnedByCaller;
      const firstCalls = probing
        ? [...first, { target: multicall3, callData: SELECTORS.getBlockNumber, allowFailure: true }]
        : first;

      const rows = await runAggregate3(
        rpc,
        input.chainId,
        firstCalls,
        multicall3,
        param,
        deadline.signal,
        "EvmMulticall",
      );

      let pinned: bigint | undefined;
      let resultRows = [...rows];
      if (probing) {
        const probe = resultRows.pop();
        const word = probe?.success === true ? wordAt(probe.returnData, 0) : undefined;
        const value = word === undefined ? undefined : wordToBigint(word);
        // A block number is a uint64 on every live chain. Anything larger
        // means whatever is at that address is not Multicall3, and pinning to
        // it would put a fabricated height in the answer.
        if (value !== undefined && value > 0n && value < 1n << 64n) pinned = value;
      }

      if (batches.length > 1 && !pinnedByCaller && pinned === undefined) {
        // Splitting without a pinned block is the silent failure this tool
        // exists to avoid: each batch would resolve "latest" separately and
        // the rows would come from different heights while still arriving as
        // one table.
        throw new ChainCallError(
          `EvmMulticall: this batch needs ${batches.length} requests and the block could not be pinned — Multicall3 at ${multicall3} did not answer getBlockNumber(), so the remaining batches would each resolve "${param}" separately and the rows would not share a block. Pass an explicit blockNumber, or raise batchSize so it fits in one request.`,
        );
      }

      const pinnedParam = pinned === undefined ? param : toQuantity(pinned);
      for (const batch of batches.slice(1)) {
        const more = await runAggregate3(
          rpc,
          input.chainId,
          batch,
          multicall3,
          pinnedParam,
          deadline.signal,
          "EvmMulticall",
        );
        resultRows = [...resultRows, ...more];
      }

      let failed = 0;
      let emptyReturns = 0;
      const results = [];
      for (const [index, row] of resultRows.entries()) {
        const call = input.calls[index] as MulticallCallInput;
        if (!row.success) {
          failed++;
          results.push({
            index,
            ...(call.label !== undefined ? { label: call.label } : {}),
            target: call.target,
            success: false,
            revert: row.revert ?? decodeRevertData(row.returnData),
          });
          continue;
        }
        const empty = row.returnData === "0x";
        if (empty) emptyReturns++;
        let decoded: unknown[] | undefined;
        let decodeError: string | undefined;
        if (call.outputs !== undefined && !empty) {
          try {
            decoded = await decodeValues(call.outputs, row.returnData, `calls[${index}]`);
          } catch (err) {
            // One contract answering in a shape the declared types cannot
            // read is a fact about that contract, not a reason to lose the
            // rest of the table.
            decodeError = (err as Error).message;
          }
        }
        results.push({
          index,
          ...(call.label !== undefined ? { label: call.label } : {}),
          target: call.target,
          success: true,
          returnData: row.returnData,
          ...(empty ? { emptyReturn: true } : {}),
          ...(decoded !== undefined ? { decoded } : {}),
          ...(decodeError !== undefined ? { decodeError } : {}),
        });
      }

      const caveats: string[] = [];
      if (emptyReturns > 0) {
        caveats.push(
          `${emptyReturns} call(s) SUCCEEDED with empty return data. In the EVM a call to an address with no code succeeds and returns nothing, so this is usually a wrong address, a contract not deployed on this chain, or a function the contract does not have — it is not a zero value, and it has deliberately not been decoded as one.`,
        );
      }
      if (pinned === undefined && !pinnedByCaller) {
        caveats.push(
          `the block was not pinned: these rows were read at "${param}", which the node resolved at request time.`,
        );
      }

      return json({
        chainId: input.chainId,
        multicall3,
        block: {
          requested: param,
          number: pinned === undefined ? null : pinned.toString(),
          pinned: pinned !== undefined || pinnedByCaller,
          source: pinnedByCaller
            ? "caller"
            : pinned === undefined
              ? "none"
              : "Multicall3 getBlockNumber() in the first batch",
        },
        requests: batches.length,
        callCount: input.calls.length,
        succeeded: input.calls.length - failed,
        failed,
        emptyReturns,
        results,
        ...(caveats.length > 0 ? { caveats } : {}),
      });
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// ContractInspect
// ---------------------------------------------------------------------------

type ViewCall = { readonly target: string; readonly callData: string };
type ViewRow = {
  readonly success: boolean;
  readonly returnData: string;
  /**
   * True when this probe failed for a reason that was NOT the contract
   * reverting. A revert is the contract's answer; this is the node's silence,
   * and the two must not read the same at the point a verdict is written.
   */
  readonly unreadable?: boolean;
};

/**
 * Run the introspection view calls, preferring one batched request.
 *
 * Multicall3 is not deployed everywhere — a local fork, an L2 that predates
 * the deterministic deploy, a chain with its own address. When the batch
 * itself fails the reads are made one at a time instead, and which path ran
 * is reported, because ten sequential round trips against a rate-limited
 * endpoint is a different thing from one.
 */
function looksLikeRevert(err: unknown): boolean {
  if (revertFromCallError(err) !== undefined) return true;
  const { code, message } = rpcError(err);
  // Geth answers a reverted eth_call with code 3. Nodes that do not attach
  // revert data still say so in the message.
  return code === 3 || /revert|out of gas|invalid opcode/i.test(message ?? "");
}

async function runViews(
  rpc: ChainRpc,
  chainId: string,
  views: ReadonlyArray<ViewCall>,
  multicall3: string,
  block: string,
  signal: AbortSignal,
): Promise<{
  mode: "multicall3" | "sequential";
  rows: ViewRow[];
  batchError?: string;
  /** Probes that failed for a reason that is NOT the contract reverting. */
  unreadable: number;
  unreadableReason?: string;
}> {
  try {
    const rows = await runAggregate3(
      rpc,
      chainId,
      views.map((v) => ({ target: v.target, callData: v.callData, allowFailure: true })),
      multicall3,
      block,
      signal,
      "ContractInspect",
    );
    return {
      mode: "multicall3",
      rows: rows.map((r) => ({ success: r.success, returnData: r.returnData })),
      unreadable: 0,
    };
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    const batchError = (err as Error).message;
    const rows: ViewRow[] = [];
    let unreadable = 0;
    let unreadableReason: string | undefined;
    for (const view of views) {
      try {
        const raw = await rpcRead(
          rpc,
          chainId,
          "eth_call",
          [{ to: view.target, data: view.callData }, block],
          signal,
        );
        rows.push({ success: true, returnData: asData(raw, "an eth_call result") });
      } catch (callErr) {
        if (isAbort(callErr, signal)) throw callErr;
        // A view that REVERTS is the answer for most of these probes: a
        // contract that is not ERC-165 reverts on supportsInterface, and one
        // that is not a proxy reverts on implementation(). A probe that
        // failed for any OTHER reason — the node is down, rate-limiting, the
        // block is pruned — taught us nothing, and must not be counted as a
        // revert, because "it reverted" reads as "it does not support that".
        const silent = !looksLikeRevert(callErr);
        if (silent) {
          unreadable++;
          unreadableReason ??= rpcErrorText(callErr);
        }
        rows.push({ success: false, returnData: "0x", ...(silent ? { unreadable: true } : {}) });
      }
    }
    return {
      mode: "sequential",
      rows,
      batchError,
      unreadable,
      ...(unreadableReason === undefined ? {} : { unreadableReason }),
    };
  }
}

/** A single-word bool return, or undefined when the call gave no word. */
function boolResult(row: ViewRow | undefined): boolean | undefined {
  if (row === undefined || !row.success) return undefined;
  const word = wordAt(row.returnData, 0);
  return word === undefined ? undefined : wordToBool(word);
}

/** A single-word address return, or undefined when it was not one. */
function addressResult(row: ViewRow | undefined, what: string): string | undefined {
  if (row === undefined || !row.success) return undefined;
  const word = wordAt(row.returnData, 0);
  if (word === undefined) return undefined;
  try {
    const address = wordToAddress(word, what);
    return address === ZERO_ADDRESS ? undefined : address;
  } catch {
    return undefined;
  }
}

export const contractInspect: RegisteredTool = buildTool({
  name: "ContractInspect",
  description:
    "Ask an address what it is before calling it: whether there is code there at all, how big it is, whether it is a proxy and what it delegates to, and which ERC-165 interfaces it claims. Use it whenever an address arrives from somewhere you did not write — a proxy's ABI is the implementation's, not the proxy's, and calling the wrong ABI produces calldata a node accepts and a contract misreads. The answer is split into what was VERIFIED and what the contract CLAIMS, because those are different kinds of fact: a proxy's implementation slot is storage, read with eth_getStorageAt, while supportsInterface is the contract answering a question about itself and a contract can lie. Contracts that claim to support the reserved 0xffffffff interface id are reported as non-compliant and their claims are dropped entirely rather than listed. A proxy whose mechanisms disagree, and a diamond that has no single implementation, come back unresolved with the reason instead of a guessed address. Read-only: it never signs, sends or deploys.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      address: z.string().min(1),
      interfaceIds: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{8}$/))
        .max(LIMITS.interfaceProbes)
        .optional()
        .describe("extra ERC-165 interface ids to probe, on top of the well-known set"),
      probeInterfaces: z
        .boolean()
        .optional()
        .describe("default true; false skips ERC-165 entirely"),
      multicall3Address: multicallAddressField,
      blockNumber: blockNumberField,
      blockTag: blockTagField,
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const rpc = resolveRpc(input.chainId, "ContractInspect");
      const target = await checkAddress(input.address, "address");
      const { param } = blockOf(input);
      const multicall3 = input.multicall3Address ?? MULTICALL3_ADDRESS;
      const caveats: string[] = [];

      const code = asData(
        await rpcRead(rpc, input.chainId, "eth_getCode", [target.address, param], deadline.signal),
        "eth_getCode",
      );
      const codeSize = byteLength(code);

      if (codeSize === 0) {
        return json({
          chainId: input.chainId,
          address: target.address,
          checksumVerified: target.checksumVerified,
          block: { requested: param },
          verified: { isContract: false, codeSize: 0 },
          claimed: {},
          caveats: [
            "there is no code at this address at this block. It is an externally owned account, a contract that has not been deployed yet, or one that has self-destructed — an address with no code TODAY can hold a contract tomorrow, because CREATE2 lets the same address be deployed to again.",
            ...(target.checksumVerified
              ? []
              : [
                  "this address was given in lowercase, so its EIP-55 checksum could not be verified and a typo would not have been caught.",
                ]),
          ],
        });
      }

      const [implWord, adminWord, beaconWord, uupsWord] = await Promise.all(
        [EIP1967_IMPLEMENTATION_SLOT, EIP1967_ADMIN_SLOT, EIP1967_BEACON_SLOT, EIP1822_SLOT].map(
          async (slot) =>
            storageWord(
              await rpcRead(
                rpc,
                input.chainId,
                "eth_getStorageAt",
                [target.address, slot, param],
                deadline.signal,
              ),
              `the storage slot ${slot}`,
            ),
        ),
      );

      const signals: ProxySignal[] = [];

      const clone = minimalProxyTarget(code);
      if (clone !== null) {
        signals.push({
          kind: "eip1167-minimal",
          implementation: clone,
          source: "the EIP-1167 minimal-proxy pattern in the runtime bytecode",
          evidence: "bytecode",
        });
      }

      const readSlotAddress = (word: string, slot: string, label: string): string | undefined => {
        if (isZeroWord(word)) return undefined;
        try {
          return wordToAddress(word, `${label} (slot ${slot})`);
        } catch {
          // A non-zero slot whose top bytes are dirty is not an address. On
          // an EIP-1822 implementation contract this slot holds the proxiable
          // UUID rather than a pointer, and masking it down to 20 bytes would
          // report a fragment of a hash as a contract.
          caveats.push(
            `${label} (slot ${slot}) is set to ${word}, which is not an address — it is reported as raw storage and not used to resolve an implementation.`,
          );
          return undefined;
        }
      };

      const slotImplementation = readSlotAddress(
        implWord as string,
        EIP1967_IMPLEMENTATION_SLOT,
        "the EIP-1967 implementation slot",
      );
      if (slotImplementation !== undefined) {
        signals.push({
          kind: "eip1967",
          implementation: slotImplementation,
          source: `the EIP-1967 implementation slot (${EIP1967_IMPLEMENTATION_SLOT})`,
          evidence: "storage",
        });
      }

      const slot1822 = readSlotAddress(uupsWord as string, EIP1822_SLOT, "the EIP-1822 slot");
      if (slot1822 !== undefined) {
        signals.push({
          kind: "eip1822",
          implementation: slot1822,
          source: `the EIP-1822 slot keccak256("PROXIABLE") (${EIP1822_SLOT})`,
          evidence: "storage",
        });
      }

      const beacon = readSlotAddress(
        beaconWord as string,
        EIP1967_BEACON_SLOT,
        "the EIP-1967 beacon slot",
      );
      const admin = readSlotAddress(
        adminWord as string,
        EIP1967_ADMIN_SLOT,
        "the EIP-1967 admin slot",
      );

      const wantInterfaces = input.probeInterfaces !== false;
      const probeIds = wantInterfaces
        ? [
            ...KNOWN_INTERFACES.map((i) => i.id),
            ...(input.interfaceIds ?? []).filter(
              (id) => !KNOWN_INTERFACES.some((i) => i.id.toLowerCase() === id.toLowerCase()),
            ),
          ]
        : [];

      const views: ViewCall[] = [
        // The compliance sentinel goes out only when its answer will be used.
        // Probing it and discarding the result would cost a call to learn
        // something nothing downstream reads.
        ...(wantInterfaces
          ? [{ target: target.address, callData: supportsInterfaceData(ERC165_INVALID_ID) }]
          : []),
        ...probeIds.map((id) => ({ target: target.address, callData: supportsInterfaceData(id) })),
        { target: target.address, callData: SELECTORS.implementation },
        { target: target.address, callData: SELECTORS.proxiableUUID },
        ...(beacon !== undefined ? [{ target: beacon, callData: SELECTORS.implementation }] : []),
      ];

      const { mode, rows, batchError, unreadable, unreadableReason } = await runViews(
        rpc,
        input.chainId,
        views,
        multicall3,
        param,
        deadline.signal,
      );
      if (batchError !== undefined) {
        caveats.push(
          `the batched read failed and the probes were made one at a time instead (${batchError}).`,
        );
      }
      if (unreadable > 0 && unreadable === views.length) {
        // Every probe failed for a reason that was not a revert. A report
        // built on that would say "not a proxy, not ERC-165" about a
        // contract nobody actually managed to ask.
        throw new ChainCallError(
          `ContractInspect: neither the batched read nor any of the ${views.length} individual probes could be answered by this node (${unreadableReason ?? "no reason given"}). Nothing was learned about this contract's interfaces or its proxy views, so no report is given — one would read as "not a proxy, not ERC-165", which is a different claim from "could not ask".`,
        );
      }
      if (unreadable > 0) {
        caveats.push(
          `${unreadable} of ${views.length} probes could not be answered by the node at all (${unreadableReason ?? "no reason given"}) — those are reported as absent, which is not the same as the contract having said no.`,
        );
      }

      let cursor = 0;
      const sentinelRow = wantInterfaces ? rows[cursor++] : undefined;
      const sentinel = wantInterfaces ? boolResult(sentinelRow) : undefined;
      const claims = probeIds.map((id) => ({ id, claimed: boolResult(rows[cursor++]) }));
      const implementationView = addressResult(rows[cursor++], "implementation()");
      const proxiableUuid = rows[cursor++];
      const beaconImplementation =
        beacon === undefined
          ? undefined
          : addressResult(rows[cursor++], "the beacon's implementation()");

      if (beacon !== undefined) {
        signals.push({
          kind: "eip1967-beacon",
          implementation: beaconImplementation ?? null,
          source: `the EIP-1967 beacon slot (${EIP1967_BEACON_SLOT}) names beacon ${beacon}, whose implementation() was then called`,
          evidence: "call",
        });
        if (beaconImplementation === undefined) {
          caveats.push(
            `the beacon at ${beacon} did not answer implementation(), so the implementation behind this beacon proxy is unknown.`,
          );
        }
      }

      // A contract that answers `true` to the reserved 0xffffffff id answers
      // true to everything, which makes every other claim it makes worthless.
      // Reporting the eleven interfaces it "supports" would be eleven wrong
      // facts a caller has no way to spot, so they are dropped.
      const erc165Compliant = sentinel === false;
      const supported = erc165Compliant
        ? claims.filter((c) => c.claimed === true).map((c) => c.id)
        : [];

      if (erc165Compliant && supported.some((id) => id.toLowerCase() === DIAMOND_LOUPE_ID)) {
        signals.push({
          kind: "diamond",
          implementation: null,
          source: "an ERC-165 claim of the EIP-2535 DiamondLoupe interface",
          evidence: "call",
        });
      }

      const proxy = reconcileProxy(signals);
      if (proxy.isProxy && proxy.signals.some((s) => s.evidence === "call")) {
        caveats.push(
          "part of this proxy verdict rests on a view CALL rather than on storage or bytecode, so it is what the contract says about itself at this block rather than a fact read out of its state.",
        );
      }
      if (!target.checksumVerified) {
        caveats.push(
          "this address was given in lowercase, so its EIP-55 checksum could not be verified and a typo would not have been caught.",
        );
      }

      const named = (id: string): string | undefined =>
        KNOWN_INTERFACES.find((i) => i.id.toLowerCase() === id.toLowerCase())?.name;

      return json({
        chainId: input.chainId,
        address: target.address,
        checksumVerified: target.checksumVerified,
        block: { requested: param },
        verified: {
          isContract: true,
          codeSize,
          storage: {
            eip1967Implementation: implWord,
            eip1967Admin: adminWord,
            eip1967Beacon: beaconWord,
            eip1822: uupsWord,
            adminAddress: admin ?? null,
            beaconAddress: beacon ?? null,
          },
          proxy: {
            isProxy: proxy.isProxy,
            resolved: proxy.resolved,
            kind: proxy.kind,
            implementation: proxy.implementation,
            signals: proxy.signals,
            ...(proxy.unresolvedReason !== undefined
              ? { unresolvedReason: proxy.unresolvedReason }
              : {}),
          },
          reads: mode,
        },
        claimed: {
          ...(!wantInterfaces
            ? {}
            : {
                erc165: erc165Compliant
                  ? {
                      compliant: true,
                      supported: supported.map((id) => ({
                        id,
                        ...(named(id) !== undefined ? { name: named(id) } : {}),
                      })),
                      probed: probeIds.length,
                      caveat:
                        "supportsInterface is the contract's own answer about itself. It is a claim, not a verification: a contract can claim an interface it does not implement, and implement one it does not claim.",
                    }
                  : {
                      compliant: false,
                      established: sentinelRow?.unreadable !== true,
                      reason:
                        // A sentinel the node never answered establishes
                        // nothing. Saying "this contract does not implement
                        // ERC-165" there is a claim about a contract nobody
                        // managed to ask — the same mistake the all-probes-
                        // failed refusal exists to prevent, one probe at a time.
                        sentinelRow?.unreadable === true
                          ? `supportsInterface(0xffffffff) could not be answered by the node at all (${unreadableReason ?? "no reason given"}), so whether this contract implements ERC-165 was never established. Its claims are dropped because none of them can be trusted without the sentinel — NOT because the contract said no.`
                          : sentinel === undefined
                            ? "supportsInterface(0xffffffff) did not return a value — this contract does not implement ERC-165, so no interface claim could be read from it"
                            : "this contract answered TRUE for the reserved 0xffffffff interface id, which ERC-165 requires to be false. It answers true to everything, so its claims carry no information and none are listed.",
                    },
              }),
          implementationView: implementationView ?? null,
          uupsProxiable: proxiableUuid?.success === true && proxiableUuid.returnData !== "0x",
          note: "implementationView and uupsProxiable are view CALLS. On a proxy they are answered by the implementation through the delegate, so they describe the code reached at this address rather than the address itself.",
        },
        ...(caveats.length > 0 ? { caveats } : {}),
      });
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// EvmSimulateBundle
// ---------------------------------------------------------------------------

const simCallSchema = z
  .object({
    from: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    data: z.string().optional().describe("calldata, 0x hex"),
    value: z.string().regex(/^\d+$/).optional().describe("native value in wei, decimal string"),
    gas: z.string().regex(/^\d+$/).optional().describe("gas cap for this call, decimal string"),
  })
  .strict();

type BalanceProbe = { readonly account: string; readonly asset: string; readonly callData: string };

/** Build the bracketing balance reads: native first, then each token. */
function balanceProbes(
  accounts: ReadonlyArray<string>,
  tokens: ReadonlyArray<string>,
  multicall3: string,
): { probes: BalanceProbe[]; calls: Call3[] } {
  const probes: BalanceProbe[] = [];
  for (const account of accounts) {
    probes.push({ account, asset: "native", callData: getEthBalanceData(account) });
  }
  for (const token of tokens) {
    for (const account of accounts) {
      probes.push({ account, asset: token, callData: balanceOfData(account) });
    }
  }
  const calls: Call3[] = probes.map((p) => ({
    target: p.asset === "native" ? multicall3 : p.asset,
    callData: p.callData,
    allowFailure: true,
  }));
  return { probes, calls };
}

/** Decode one bracket's aggregate3 blob into a balance per probe. */
function readProbeBlob(returnData: string, count: number): Array<bigint | null> {
  const rows = decodeAggregate3(returnData, count);
  return rows.map((row) => {
    if (!row.success) return null;
    const word = wordAt(row.returnData, 0);
    return word === undefined ? null : wordToBigint(word);
  });
}

export const evmSimulateBundle: RegisteredTool = buildTool({
  name: "EvmSimulateBundle",
  description:
    "Simulate an ordered sequence of calls against a block and report what each one would do — status, gas, return data, revert reason, logs — without submitting anything. Use it to check a plan before approving it: an approve followed by a swap, a multi-step position change, a governance execution. The point is that state CHAINS, so the second call sees what the first one did. That needs eth_simulateV1, which many endpoints do not implement; when one does not, this falls back to independent eth_calls and says so in `mode`, sets `chained: false`, and OMITS logs and balance deltas entirely rather than reporting the half that survives — a partially-true effects summary is precisely what a policy gate would trust and be wrong about. A timeout or a rejected parameter is never degraded into a fallback, because neither says the node cannot answer the real question. Optional balance tracking brackets the bundle with Multicall3 balance reads, so native and ERC-20 deltas come from the chain's own accounting rather than from summing Transfer logs, which miss fee-on-transfer and rebasing tokens. It simulates only: no key is accepted, nothing is signed, and nothing is broadcast.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      calls: z.array(simCallSchema).min(1).max(LIMITS.bundleCalls),
      blockNumber: blockNumberField,
      blockTag: blockTagField,
      stateOverrides: z
        .record(z.record(z.unknown()))
        .optional()
        .describe("per-address overrides (balance, nonce, code, state/stateDiff)"),
      blockOverrides: z
        .record(z.unknown())
        .optional()
        .describe("per-block overrides (time, number, baseFeePerGas, gasLimit)"),
      validation: z
        .boolean()
        .optional()
        .describe("default false; true makes the node check nonces, balances and fees"),
      traceTransfers: z
        .boolean()
        .optional()
        .describe("default true; surfaces native value moves as synthetic Transfer logs"),
      allowFallback: z
        .boolean()
        .optional()
        .describe("default true; false refuses rather than answering the unchained question"),
      trackBalances: z
        .object({
          accounts: z
            .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
            .min(1)
            .max(LIMITS.trackedAccounts),
          tokens: z
            .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
            .max(LIMITS.trackedTokens)
            .optional(),
        })
        .strict()
        .optional()
        .describe("read these balances before and after the bundle, inside the simulation"),
      multicall3Address: multicallAddressField,
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const rpc = resolveRpc(input.chainId, "EvmSimulateBundle");
      const { param } = blockOf(input);
      const multicall3 = input.multicall3Address ?? MULTICALL3_ADDRESS;
      const traceTransfers = input.traceTransfers ?? true;

      const userCalls = input.calls.map((call, index) => toWireCall(call, index));

      let probes: BalanceProbe[] = [];
      let bracketed = userCalls;
      if (input.trackBalances !== undefined) {
        const built = balanceProbes(
          input.trackBalances.accounts,
          input.trackBalances.tokens ?? [],
          multicall3,
        );
        probes = built.probes;
        // The probes ride INSIDE the bundle so they see the same chained
        // state the calls do. Reading balances with a separate eth_call
        // afterwards would read the real chain, where none of this happened.
        const packed = encodeAggregate3(built.calls, multicall3);
        const bracket = { to: packed.to, input: packed.data };
        bracketed = [bracket, ...userCalls, bracket];
      }

      const payload = {
        blockStateCalls: [
          {
            calls: bracketed,
            ...(input.stateOverrides !== undefined ? { stateOverrides: input.stateOverrides } : {}),
            ...(input.blockOverrides !== undefined ? { blockOverrides: input.blockOverrides } : {}),
          },
        ],
        validation: input.validation ?? false,
        traceTransfers,
        returnFullTransactions: false,
      };

      let raw: unknown;
      try {
        raw = await rpcRead(
          rpc,
          input.chainId,
          "eth_simulateV1",
          [payload, param],
          deadline.signal,
        );
      } catch (err) {
        if (isAbort(err, deadline.signal)) {
          // A failure a cancellation could also produce must name its
          // reason. A deadline or a cancelled run says nothing about whether
          // the node implements eth_simulateV1, so degrading here would turn
          // a slow endpoint into a permanently weaker answer that still
          // reads like an answer.
          throw new ChainCallError(
            "EvmSimulateBundle: the call was cancelled — the deadline elapsed, or the run was cancelled — before the node answered eth_simulateV1. This is NOT treated as an unimplemented method, so no eth_call fallback was attempted; raise timeoutMs or retry.",
            err,
          );
        }
        if (!isMethodUnsupported(err, deadline.signal)) {
          throw new ChainCallError(
            `EvmSimulateBundle: the node refused this bundle — ${rpcErrorText(err)}. The node implements eth_simulateV1, so this is an answer about the bundle and not a reason to fall back to eth_call.`,
            err,
          );
        }
        if (input.allowFallback === false) {
          throw new ChainCallError(
            `EvmSimulateBundle: this endpoint does not implement eth_simulateV1 (${rpcErrorText(err)}) and allowFallback is false. The eth_call fallback cannot chain state between calls, so it answers a different question; re-run with allowFallback, or point at an endpoint that implements eth_simulateV1.`,
            err,
          );
        }
        if (input.trackBalances !== undefined) {
          throw new ChainCallError(
            `EvmSimulateBundle: this endpoint does not implement eth_simulateV1 (${rpcErrorText(err)}), and trackBalances needs the chained after-state that only a real simulation has. There is no honest delta to compute from independent eth_calls, so none is reported — re-run without trackBalances for per-call outcomes, or use an endpoint that implements eth_simulateV1.`,
            err,
          );
        }
        return json(await fallbackBundle(rpc, input.chainId, input.calls, param, deadline.signal));
      }

      const block = parseSimulateV1(raw, bracketed.length);
      const tracking = input.trackBalances !== undefined;
      const inner = tracking ? block.calls.slice(1, -1) : block.calls;
      const calls = inner.map((call, index) => ({ ...call, index }));

      const limitations: string[] = [];
      if (traceTransfers) {
        limitations.push(
          "traceTransfers is on, so native value movements appear as synthetic ERC-20-shaped Transfer logs emitted by the zero address. They are not events any contract actually emitted.",
        );
      }
      // The same absence-is-not-emptiness rule the fallback keeps, applied to
      // the path that usually runs. A node can implement eth_simulateV1 and
      // still return no log list; the rows then carry no `logs` key, and a
      // reader who is not told that would take the missing key for silence.
      const withoutLogs = calls.filter((call) => call.logs === undefined).length;
      if (withoutLogs > 0) {
        limitations.push(
          `${withoutLogs} of ${calls.length} call(s) came back from this node with NO log list, so no \`logs\` key is written on them. That is absence, not "this call emitted no events" — a call the node did report logs for carries the key, empty when it emitted nothing.`,
        );
      }
      const withoutGas = calls.filter((call) => call.gasUsed === undefined).length;
      if (withoutGas > 0) {
        limitations.push(
          `${withoutGas} of ${calls.length} call(s) came back with no gasUsed figure, so no \`gasUsed\` key is written on them rather than a zero.`,
        );
      }

      const balanceChanges = tracking
        ? readBalanceChanges(block.calls, probes, multicall3)
        : undefined;

      return json({
        chainId: input.chainId,
        mode: "eth_simulateV1",
        chained: true,
        blockNumber: block.blockNumber,
        callCount: calls.length,
        reverted: calls.filter((c) => c.status === "reverted").length,
        calls,
        ...(balanceChanges !== undefined ? { balanceChanges } : {}),
        ...(limitations.length > 0 ? { limitations } : {}),
      });
    } finally {
      deadline.cancel();
    }
  },
});

/**
 * Difference the two bracketing balance reads, or say why there is nothing
 * to difference.
 *
 * Three ways this declines, and none of them produces a partial delta: the
 * bracket did not execute (no Multicall3 at that address), it executed but
 * did not answer in Multicall3's shape, or one probe inside it failed — the
 * last is per-entry, because a token that has no code is a fact about that
 * token and not about the other rows.
 */
function readBalanceChanges(
  calls: ReadonlyArray<SimCallResult>,
  probes: ReadonlyArray<BalanceProbe>,
  multicall3: string,
): Record<string, unknown> {
  const before = calls[0] as SimCallResult;
  const after = calls[calls.length - 1] as SimCallResult;
  if (before.status !== "success" || after.status !== "success") {
    return {
      ok: false,
      reason: `the bracketing balance read did not execute — Multicall3 at ${multicall3} is probably not deployed on this chain. No deltas are reported rather than partial ones.`,
    };
  }

  let start: Array<bigint | null>;
  let end: Array<bigint | null>;
  try {
    start = readProbeBlob(before.returnData, probes.length);
    end = readProbeBlob(after.returnData, probes.length);
  } catch (err) {
    return {
      ok: false,
      reason: `the bracketing balance read at ${multicall3} did not answer in Multicall3's shape, so nothing could be differenced from it — ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    entries: probes.map((probe, i) => {
      const from = start[i];
      const to = end[i];
      if (from === null || from === undefined || to === null || to === undefined) {
        return {
          account: probe.account,
          asset: probe.asset,
          ok: false,
          reason:
            "this balance could not be read inside the simulation — the token has no code at this address, or it does not implement balanceOf(address)",
        };
      }
      return {
        account: probe.account,
        asset: probe.asset,
        beforeWei: from.toString(),
        afterWei: to.toString(),
        deltaWei: (to - from).toString(),
      };
    }),
    note: "these come from the chain's own balance accounting inside the simulated state, not from summing Transfer logs, so fee-on-transfer and rebasing tokens are counted correctly. The native figures include gas paid by the simulated caller.",
  };
}

/**
 * The lesser answer, stated as one.
 *
 * Every call here runs against the SAME unmodified block, so this is not the
 * bundle the caller described — it is each of its calls asked separately. No
 * `logs` key is written on any row and no `balanceChanges` key on the
 * result: an empty list would be read as "nothing happened", and the
 * difference between that and "this could not be observed" is the difference
 * between a gate passing and a gate being fooled.
 */
async function fallbackBundle(
  rpc: ChainRpc,
  chainId: string,
  calls: ReadonlyArray<z.infer<typeof simCallSchema>>,
  block: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  // One resolution, then one height for every call. A tag sent N times is
  // resolved N times, and the head moving mid-loop puts rows from two blocks
  // into one table while the limitation below claims they share one — the
  // exact inconsistency EvmMulticall refuses to produce when it has to split.
  const pinned = await resolveFallbackBlock(rpc, chainId, block, signal);
  const at = pinned === null ? block : toQuantity(pinned);

  const rows = [];
  let reverted = 0;
  for (const [index, call] of calls.entries()) {
    const wire = toWireCall(call, index);
    try {
      const raw = await rpcRead(rpc, chainId, "eth_call", [wire, at], signal);
      rows.push({
        index,
        status: "success" as const,
        returnData: asData(raw, `the eth_call result for call ${index}`),
      });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      const revert = revertFromCallError(err);
      reverted++;
      rows.push({
        index,
        status: "reverted" as const,
        returnData: revert?.data ?? "0x",
        ...(revert !== undefined ? { revert } : {}),
        error: rpcErrorText(err),
      });
    }
  }
  return {
    chainId,
    mode: "eth_call-fallback",
    chained: false,
    blockNumber: pinned === null ? null : pinned.toString(),
    callCount: rows.length,
    reverted,
    calls: rows,
    limitations: [
      unchainedLimitation(pinned === null ? null : pinned.toString()),
      ...FALLBACK_LIMITATIONS,
    ],
    note: "this endpoint does not implement eth_simulateV1, so the bundle was NOT simulated as a sequence. Each call below was evaluated independently; this answers a different question from the one asked.",
  };
}

/**
 * Resolve a block tag to the height the fallback will hold every call at, or
 * null when the node will not say.
 *
 * A caller-supplied number needs no round trip — it is already a height. A
 * tag costs one `eth_getBlockByNumber`, and a tag that cannot be resolved is
 * reported as unpinned rather than silently sent once per call: an extra read
 * is cheap, and a table whose rows came from two heights is not.
 */
async function resolveFallbackBlock(
  rpc: ChainRpc,
  chainId: string,
  block: string,
  signal: AbortSignal,
): Promise<bigint | null> {
  if (block.startsWith("0x")) return quantity(block, "the pinned block");
  try {
    const raw = await rpcRead(rpc, chainId, "eth_getBlockByNumber", [block, false], signal);
    if (raw === null || typeof raw !== "object") return null;
    const number = (raw as Record<string, unknown>)["number"];
    return number === undefined || number === null ? null : quantity(number, "the block's number");
  } catch (err) {
    // A cancellation is still a cancellation, and a method the allowlist
    // refused is a defect in this file — neither may be swallowed into
    // "unpinned", which is a sentence about the chain rather than about us.
    if (isAbort(err, signal) || (err as { name?: string })?.name === "ChainAdapterError") throw err;
    return null;
  }
}

// ---------------------------------------------------------------------------
// GasMarketRead
// ---------------------------------------------------------------------------

/** The OP-stack GasPriceOracle predeploy, identical across every OP chain. */
const OP_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

export const gasMarketRead: RegisteredTool = buildTool({
  name: "GasMarketRead",
  description:
    "Read a chain's fee market: the current base fee, priority-fee percentiles from eth_feeHistory over a window of blocks, and the next block's base fee computed by the EIP-1559 rule. Use it to decide when to send and what to pay, instead of a model recalling a gwei figure. It reports WHICH mechanism the chain is running rather than assuming one — a chain with no baseFeePerGas has no 1559 market and is reported as legacy, a node without eth_feeHistory is reported as such instead of being filled in, and a base fee that never moves across the window is flagged rather than trended. The projection is computed from the block's integer gasUsed and gasLimit, never from feeHistory's floating-point gasUsedRatio, and is compared against the node's own next-block figure so a chain with a non-standard elasticity shows up as a disagreement rather than as a confident wrong number. It does not price rollup L1 data fees, and says so — on an OP-stack chain it checks whether the GasPriceOracle predeploy is there and warns that the cost it does not report is often the larger one.",
  inputSchema: z
    .object({
      chainId: chainIdField,
      blockCount: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.feeBlocks)
        .optional()
        .describe("blocks of fee history to sample; default 20"),
      percentiles: z
        .array(z.number().min(0).max(100))
        .min(1)
        .max(8)
        .optional()
        .describe("priority-fee percentiles, ascending; default [10, 50, 90]"),
      blockNumber: blockNumberField,
      blockTag: blockTagField,
      gasLimit: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("gas for a planned transaction, decimal; prices it at atPercentile"),
      atPercentile: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("which percentile to price the planned transaction at; default 50"),
      checkRollupOracle: z
        .boolean()
        .optional()
        .describe("default true; one eth_getCode to see if an OP-stack L1 fee applies"),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const rpc = resolveRpc(input.chainId, "GasMarketRead");
      const { param } = blockOf(input);
      const blockCount = input.blockCount ?? 20;
      const percentiles = input.percentiles ?? [10, 50, 90];
      const caveats: string[] = [];

      for (let i = 1; i < percentiles.length; i++) {
        if ((percentiles[i] as number) <= (percentiles[i - 1] as number)) {
          throw new ChainCallError(
            `GasMarketRead: eth_feeHistory requires strictly ascending percentiles; [${percentiles.join(", ")}] is not`,
          );
        }
      }

      const rawBlock = await rpcRead(
        rpc,
        input.chainId,
        "eth_getBlockByNumber",
        [param, false],
        deadline.signal,
      );
      if (rawBlock === null || typeof rawBlock !== "object") {
        throw new ChainCallError(
          `GasMarketRead: the node has no block at "${param}" — it may be pruned, or the chain may not have reached it`,
        );
      }
      const block = rawBlock as Record<string, unknown>;
      const baseFee = optionalQuantity(block["baseFeePerGas"], "the block's baseFeePerGas");
      const gasUsed = quantity(block["gasUsed"], "the block's gasUsed");
      const gasLimit = quantity(block["gasLimit"], "the block's gasLimit");
      const blockNumber = quantity(block["number"], "the block's number");

      let history: Record<string, unknown> | undefined;
      try {
        const raw = await rpcRead(
          rpc,
          input.chainId,
          "eth_feeHistory",
          [toQuantity(BigInt(blockCount)), param, percentiles],
          deadline.signal,
        );
        if (raw !== null && typeof raw === "object") history = raw as Record<string, unknown>;
      } catch (err) {
        if (isAbort(err, deadline.signal)) throw err;
        if (!isMethodUnsupported(err, deadline.signal)) throw err;
        caveats.push(
          `this node does not implement eth_feeHistory (${rpcErrorText(err)}), so there are no priority-fee percentiles and no sampled window — only the head block's own figures.`,
        );
      }

      let gasPrice: bigint | undefined;
      try {
        gasPrice = quantity(
          await rpcRead(rpc, input.chainId, "eth_gasPrice", [], deadline.signal),
          "eth_gasPrice",
        );
      } catch (err) {
        if (isAbort(err, deadline.signal)) throw err;
        caveats.push(`eth_gasPrice was not answered (${rpcErrorText(err)}).`);
      }

      const historyBaseFees = Array.isArray(history?.["baseFeePerGas"])
        ? (history["baseFeePerGas"] as unknown[]).map((v, i) =>
            quantity(v, `feeHistory.baseFeePerGas[${i}]`),
          )
        : [];
      const rewards = Array.isArray(history?.["reward"]) ? (history["reward"] as unknown[]) : [];

      const mechanism = baseFee === undefined ? "legacy" : "eip1559";

      let projection: Record<string, unknown> | undefined;
      if (baseFee !== undefined) {
        // gasUsedRatio in feeHistory is a JSON float and has already lost the
        // low bits of gasUsed. The rule is integer arithmetic on wei, so it
        // reads the block's own gasUsed and gasLimit instead.
        const computed = nextBaseFee(baseFee, gasUsed, gasLimit);
        const nodeNext = historyBaseFees[historyBaseFees.length - 1];
        const agrees = nodeNext === undefined ? null : nodeNext === computed.next;
        if (agrees === false) {
          caveats.push(
            `the next base fee this tool computed (${computed.next}) differs from the one the node reported (${nodeNext}). This chain does not follow the vanilla EIP-1559 rule — a different elasticity, a different change denominator, or a floor — so trust the node's figure and treat the computed one as a cross-check that failed.`,
          );
        }
        projection = {
          computedWei: computed.next.toString(),
          nodeReportedWei: nodeNext === undefined ? null : nodeNext.toString(),
          agrees,
          direction: computed.direction,
          gasTarget: computed.target.toString(),
          rule: "EIP-1559: the base fee moves by at most 1/8 per block toward gasLimit/2",
        };
      }

      const summaries = percentiles
        .map((percentile, column) => {
          const values: bigint[] = [];
          for (const [row, entry] of rewards.entries()) {
            if (!Array.isArray(entry)) continue;
            const value = entry[column];
            if (value === undefined || value === null) continue;
            values.push(quantity(value, `feeHistory.reward[${row}][${column}]`));
          }
          return summarisePercentile(percentile, values);
        })
        .filter((s): s is NonNullable<typeof s> => s !== undefined);

      const windowFees = historyBaseFees.slice(0, -1);
      const first = windowFees[0];
      const last = windowFees[windowFees.length - 1];
      const constant =
        windowFees.length > 1 && windowFees.every((f) => f === (windowFees[0] as bigint));
      if (constant) {
        caveats.push(
          "the base fee is identical in every sampled block. Several chains hold it at a floor and price congestion elsewhere (Arbitrum) or have no dynamic 1559 market at all, so do not read this as a quiet market.",
        );
      }
      if (
        baseFee !== undefined &&
        windowFees.length > 0 &&
        (windowFees[windowFees.length - 1] as bigint) !== baseFee
      ) {
        caveats.push(
          "the fee-history window does not end at the block that was read — the head moved between the two requests, so the window and the head block are one block apart.",
        );
      }

      let rollup: Record<string, unknown> | undefined;
      if (input.checkRollupOracle !== false) {
        try {
          const code = asData(
            await rpcRead(
              rpc,
              input.chainId,
              "eth_getCode",
              [OP_GAS_PRICE_ORACLE, param],
              deadline.signal,
            ),
            "eth_getCode for the GasPriceOracle predeploy",
          );
          rollup = { opStackGasPriceOracle: byteLength(code) > 0, address: OP_GAS_PRICE_ORACLE };
          if (byteLength(code) > 0) {
            caveats.push(
              `there IS an OP-stack GasPriceOracle at ${OP_GAS_PRICE_ORACLE}, so this chain charges an L1 data fee on top of everything below — frequently the larger share of a transaction's cost. This tool does not read that oracle or compute the post-Ecotone blob-scalar formula, so every figure here is execution gas only.`,
            );
          }
        } catch {
          // Not knowing whether a predeploy is there is not a reason to fail
          // a fee read; the general caveat below still applies.
        }
      }
      caveats.push(
        "these are execution-gas figures for this chain alone. On any rollup the L1 data fee is charged separately and is not included here.",
      );

      let planned: Record<string, unknown> | undefined;
      if (input.gasLimit !== undefined) {
        const gas = BigInt(input.gasLimit);
        const at = input.atPercentile ?? 50;
        const chosen = summaries.find((s) => s.percentile === at) ?? summaries[0];
        if (chosen !== undefined && chosen.percentile !== at) {
          // Quietly pricing at another percentile is how a caller who asked
          // for the 90th under-tips at the 10th and never learns why.
          caveats.push(
            `the ${at}th priority-fee percentile was not among the ones this node answered, so the planned transaction below is priced at the ${chosen.percentile}th instead. Ask for it in \`percentiles\` if you need it.`,
          );
        }
        if (baseFee === undefined) {
          planned =
            gasPrice === undefined
              ? {
                  ok: false,
                  reason:
                    "this chain has no 1559 market and the node did not answer eth_gasPrice, so there is nothing to price against",
                }
              : {
                  ok: true,
                  mechanism: "legacy",
                  gasLimit: gas.toString(),
                  gasPriceWei: gasPrice.toString(),
                  estimatedCostWei: (gas * gasPrice).toString(),
                };
        } else {
          // The node's own next-block figure wins over ours: when the two
          // disagree it is this chain's rule that differs, not the node's
          // arithmetic, and the caveat above already says so.
          const nodeNext = projection?.["nodeReportedWei"] as string | null | undefined;
          const computedNext = projection?.["computedWei"] as string | undefined;
          const next = BigInt(nodeNext ?? computedNext ?? baseFee.toString());
          const tip = chosen === undefined ? 0n : BigInt(chosen.medianWei);
          // Two base fees of headroom is the common wallet default: the base
          // fee can rise by 1/8 per block, so 2x covers roughly six blocks of
          // sustained full blocks. Unspent headroom is refunded.
          const maxFee = next * 2n + tip;
          planned = {
            ok: true,
            mechanism: "eip1559",
            gasLimit: gas.toString(),
            requestedPercentile: at,
            atPercentile: chosen?.percentile ?? null,
            maxPriorityFeePerGasWei: tip.toString(),
            suggestedMaxFeePerGasWei: maxFee.toString(),
            expectedCostWei: (gas * (next + tip)).toString(),
            worstCaseCostWei: (gas * maxFee).toString(),
            ...(chosen === undefined
              ? {
                  note: "no percentile data was available, so the tip is 0 — that is an absence, not a market reading",
                }
              : {}),
          };
        }
      }

      return json({
        chainId: input.chainId,
        mechanism,
        block: {
          number: blockNumber.toString(),
          requested: param,
          baseFeePerGasWei: baseFee === undefined ? null : baseFee.toString(),
          gasUsed: gasUsed.toString(),
          gasLimit: gasLimit.toString(),
        },
        gasPriceWei: gasPrice === undefined ? null : gasPrice.toString(),
        ...(projection !== undefined ? { nextBaseFee: projection } : {}),
        feeHistory:
          history === undefined
            ? { available: false }
            : {
                available: true,
                blocks: windowFees.length,
                oldestBlock:
                  optionalQuantity(history["oldestBlock"], "feeHistory.oldestBlock")?.toString() ??
                  null,
                baseFeeFirstWei: first === undefined ? null : first.toString(),
                baseFeeLastWei: last === undefined ? null : last.toString(),
                baseFeeChangeBps:
                  first === undefined || last === undefined
                    ? null
                    : (changeBps(first, last) ?? null),
                baseFeeConstant: constant,
                priorityFees: summaries,
              },
        ...(blobFees(history) ?? {}),
        ...(rollup !== undefined ? { rollup } : {}),
        ...(planned !== undefined ? { planned } : {}),
        caveats,
      });
    } finally {
      deadline.cancel();
    }
  },
});

/**
 * The blob market, when the chain has one.
 *
 * The next blob base fee is taken from the node's own tail entry rather than
 * recomputed: EIP-4844 prices blobs with an exponential, not the 1559 linear
 * rule, and approximating it with the wrong formula would produce a number
 * that looks like the others and is not.
 */
function blobFees(
  history: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const raw = history?.["baseFeePerBlobGas"];
  if (!Array.isArray(raw) || raw.length < 2) return undefined;
  const values = raw.map((v, i) => quantity(v, `feeHistory.baseFeePerBlobGas[${i}]`));
  const current = values[values.length - 2] as bigint;
  const next = values[values.length - 1] as bigint;
  return {
    blobs: {
      baseFeePerBlobGasWei: current.toString(),
      nextBaseFeePerBlobGasWei: next.toString(),
      source:
        "the node's own feeHistory — EIP-4844 prices blob gas with an exponential rule, not the 1559 linear one, so this is not recomputed here",
    },
  };
}

/** Every tool this package registers, in the order a catalog should list them. */
export const CHAINCALL_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  contractInspect,
  evmMulticall,
  evmSimulateBundle,
  gasMarketRead,
]);
