/**
 * Catalog F2 `target-onchain-game` — §47.
 *
 * Codegen for the `onchain-game` perceive-act-perceive loop. The
 * emitted bundle is a single `agent.ts` file that:
 *
 *   1. Constructs the chain adapter from `chain` (slice-0
 *      `@crewhaus/chain-adapter-evm` is the only adapter shipped
 *      today).
 *   2. Constructs a wallet engine bound to the single player wallet.
 *   3. Defines a `playOneTurn()` function that:
 *        a. Reads game state via `game.stateReader` (a view function).
 *        b. Classifies the raw state payload via
 *           `classifyBoundary({origin: "chain"})`.
 *        c. Calls the agent with the state + objective in the user
 *           message (one `runChatLoop({singleTurn: true})` call).
 *        d. Parses the agent's terminal output for a move action and
 *           dispatches via the wallet-engine
 *           `requestSignAndBroadcast()` flow.
 *        e. Waits for confirmation up to `moveTimeoutMs` (real-time)
 *           or indefinitely (turn-based / async).
 *   4. For `turn-based`: loops `playOneTurn()` until the agent
 *      reports the objective met or the move count hits a configured
 *      ceiling. For `real-time`: drives the loop on a fixed cadence.
 *      For `async`: subscribes to a state-change event and runs one
 *      turn per inbound state mutation.
 *   5. Emits JSON events for turn-start / turn-end / move-broadcast /
 *      move-confirmed / game-over.
 *
 * Slice 2 ships the codegen surface — the emitted file references
 * runtime packages by name. A follow-up slice wires the agent run
 * loop end-to-end against an anvil fork.
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { Bundle, IrChainGameV0, IrSecretRef } from "@crewhaus/ir";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

function renderSecretRef(ref: IrSecretRef): string {
  if (ref.kind === "literal") return JSON.stringify(ref.value);
  return `process.env[${JSON.stringify(ref.name)}] ?? (() => { throw new Error(${JSON.stringify(
    `missing required env var ${ref.name}`,
  )}); })()`;
}

/**
 * #159 (CWE-798) — a wallet signing key must never be a bare literal in
 * the emitted DO-NOT-EDIT artifact. The compiler's `lowerWalletKeyRef`
 * already rejects literal keyRefs at lower time; this is the
 * defense-in-depth guard at the emit boundary (e.g. for a hand-built IR
 * that bypassed the lowerer). Env refs pass; only `kms://` / `hsm://`
 * key handles are permitted as literals.
 */
const KEY_HANDLE_RE = /^(kms|hsm):\/\/.+/;
function renderWalletKeyRef(walletId: string, ref: IrSecretRef): string {
  if (ref.kind === "literal" && !KEY_HANDLE_RE.test(ref.value)) {
    throw new TargetEmitError(
      `wallet "${walletId}" keyRef is a literal signing key; refusing to embed it in the generated bundle. Use an environment reference or a kms:// / hsm:// handle.`,
    );
  }
  return renderSecretRef(ref);
}

export function emitOnchainGame(ir: IrChainGameV0): Bundle {
  if (ir.chain.id !== ir.wallet.chainId) {
    throw new TargetEmitError(
      `wallet.chainId "${ir.wallet.chainId}" does not match chain.id "${ir.chain.id}"`,
    );
  }
  if (ir.chain.id !== ir.game.contract.chainId) {
    throw new TargetEmitError(
      `game.contract.chainId "${ir.game.contract.chainId}" does not match chain.id "${ir.chain.id}"`,
    );
  }
  if (ir.game.turnSemantics === "real-time" && ir.game.moveTimeoutMs === undefined) {
    throw new TargetEmitError(
      "real-time games require game.moveTimeoutMs so the loop can bound per-move spend",
    );
  }

  const rpcs = ir.chain.rpcUrls.map(renderSecretRef).join(", ");
  const finality =
    ir.chain.finality.kind === "confirmations"
      ? `{ kind: "confirmations", count: ${ir.chain.finality.count} }`
      : `{ kind: ${JSON.stringify(ir.chain.finality.kind)} }`;

  const policy = ir.transactionPolicy;
  // #151 — resolve the declared game contract (id -> address) into the policy
  // so the wallet-engine can bind `tx.to` to the address registered for the
  // claimed contractId. A game is single-contract, so the map carries exactly
  // the one entry the move-broadcast flow can target.
  const contractAddresses: Record<string, string> = {
    [ir.game.contract.id]: ir.game.contract.address,
  };
  const policyLiteral = JSON.stringify({
    defaultWriteApproval: policy.defaultWriteApproval,
    allowedContracts: policy.allowedContracts,
    simulationRequired: policy.simulationRequired,
    ...(policy.maxValueUsd !== undefined ? { maxValueUsd: policy.maxValueUsd } : {}),
    contractAddresses,
  });

  const walletKeyRef =
    ir.wallet.keyRef !== undefined
      ? `, keyRef: ${renderWalletKeyRef(ir.wallet.id, ir.wallet.keyRef)}`
      : "";

  const objectiveField =
    ir.game.objective !== undefined ? `\n  objective: ${escapeJsonString(ir.game.objective)},` : "";
  const moveTimeoutField =
    ir.game.moveTimeoutMs !== undefined ? `\n  moveTimeoutMs: ${ir.game.moveTimeoutMs},` : "";
  const actionsContractField =
    ir.game.actionsContract !== undefined
      ? `\n  actionsContract: ${JSON.stringify(ir.game.actionsContract)},`
      : "";

  const instructions = escapeJsonString(ir.agent.instructions);
  const name = escapeJsonString(ir.name);

  // Header is a `//` line comment using the JSON-escaped name: a raw ir.name in
  // a block comment lets a crafted spec.name containing `*/` (or a newline) break
  // out of the comment and inject top-level code — RCE on build/run (#147).
  const content = `// Generated by @crewhaus/target-onchain-game (§47 onchain-game).
// Compiled from spec: ${name}
// DO NOT EDIT — re-run \`crewhaus compile\` to regenerate.
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { createEvmAdapter } from "@crewhaus/chain-adapter-evm";

export const SPEC_NAME = ${name};
export const AGENT_MODEL = ${JSON.stringify(ir.agent.model)};
export const AGENT_INSTRUCTIONS = ${instructions};

export const CHAIN = {
  chainId: ${JSON.stringify(ir.chain.id)},
  rpcUrls: [${rpcs}],
  rpcPolicy: ${JSON.stringify(ir.chain.rpcPolicy)},
  finality: ${finality},
  reorgTolerant: ${ir.chain.reorgTolerant},
};

export const WALLET = {
  id: ${JSON.stringify(ir.wallet.id)},
  chainId: ${JSON.stringify(ir.wallet.chainId)},
  custody: ${JSON.stringify(ir.wallet.custody)},
  signingPolicy: ${JSON.stringify(ir.wallet.signingPolicy)}${walletKeyRef},
};

export const GAME = {
  contract: {
    id: ${JSON.stringify(ir.game.contract.id)},
    chainId: ${JSON.stringify(ir.game.contract.chainId)},
    address: ${JSON.stringify(ir.game.contract.address)},
    abiRef: ${JSON.stringify(ir.game.contract.abiRef)},
  },
  stateReader: ${JSON.stringify(ir.game.stateReader)},
  turnSemantics: ${JSON.stringify(ir.game.turnSemantics)},${actionsContractField}${moveTimeoutField}${objectiveField}
};

export const TRANSACTION_POLICY = ${policyLiteral};

/**
 * Build the chain adapter (one per game; games are single-chain). The
 * runtime reads CHAIN at boot, constructs the adapter, and feeds it
 * into the wallet engine + the tool catalog.
 */
export function buildAdapter(): ReturnType<typeof createEvmAdapter> {
  return createEvmAdapter(CHAIN);
}

/**
 * Defense-in-depth: classify the raw game state payload before
 * injecting into the model's user message. The chain adapter already
 * classified the RPC envelope; this catches any inner content.
 */
export async function readAndClassifyState(adapter: ReturnType<typeof createEvmAdapter>): Promise<{
  accept: boolean;
  state: string;
}> {
  const raw = await adapter.rpcRead("eth_call", [
    { to: GAME.contract.address, data: "0x" + selectorOf(GAME.stateReader) },
    "latest",
  ]);
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const verdict = await classifyBoundary(text, { origin: "chain" });
  if (verdict.action === "redact") {
    return { accept: false, state: verdict.redacted ?? "[game state redacted]" };
  }
  return { accept: true, state: text };
}

/**
 * Compute the 4-byte selector for an ABI method name. Slice 2 ships
 * a stub that errors — the real keccak-256 lives in a follow-up
 * (alongside the calldata-encoder slot in tool-contract-gateway).
 * Until then, the spec author can pre-compute the selector and pass
 * it as the stateReader value (e.g. "70a08231").
 */
function selectorOf(method: string): string {
  if (/^[0-9a-fA-F]{8}$/.test(method)) return method.toLowerCase();
  throw new Error(
    \`selectorOf: pass a precomputed 4-byte hex selector for "\${method}" until the keccak helper ships\`,
  );
}
`;

  return { files: [{ path: "agent.ts", content }] };
}
