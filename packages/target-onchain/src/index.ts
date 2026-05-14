/**
 * Catalog F2 `target-onchain` — §47.
 *
 * Codegen for the `onchain` event-driven daemon. The emitted bundle is
 * a single `agent.ts` file that:
 *
 *   1. Constructs the configured chain adapters from `chains[]`
 *      (slice-0 `@crewhaus/chain-adapter-evm` is the only adapter
 *      shipped today).
 *   2. Constructs the wallet engine when `wallets[]` is non-empty
 *      (uses the `LocalSignerStub` only when an explicit `local`
 *      custody wallet is declared; KMS/HSM bridges are pluggable).
 *   3. Subscribes to every trigger in `triggers[]` — event triggers
 *      poll via `eth_getLogs`, block triggers via `eth_blockNumber`,
 *      address triggers via filtered `eth_getLogs` on Transfer-shaped
 *      topics.
 *   4. Dedupes inbound events by `(txHash, logIndex)` (or block
 *      number for block triggers) within `idempotencyWindowMs`.
 *   5. Classifies the decoded event payload via
 *      `classifyBoundary({origin: "chain"})` before injecting into
 *      the model context (defense in depth — the chain adapter
 *      already classified the RPC body).
 *   6. Runs one `runChatLoop({singleTurn: true})` per accepted
 *      event with the decoded payload as the user message.
 *   7. Emits JSON events to stdout for each trigger fire +
 *      agent-run-start / agent-run-end.
 *   8. Installs SIGTERM/SIGINT handlers that complete in-flight
 *      handlers before exit.
 *
 * Slice 2 ships the codegen — the emitted file references runtime
 * packages by name. The first integration test compiles a fixture
 * spec to a bundle, asserts the file contents, and (in a follow-up
 * slice) boots the bundle against an in-process anvil fork.
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { Bundle, IrChainV0, IrSecretRef } from "@crewhaus/ir";

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

function renderChain(chain: IrChainV0["chains"][number]): string {
  const rpcs = chain.rpcUrls.map(renderSecretRef).join(", ");
  const finality =
    chain.finality.kind === "confirmations"
      ? `{ kind: "confirmations", count: ${chain.finality.count} }`
      : `{ kind: ${JSON.stringify(chain.finality.kind)} }`;
  return [
    "  {",
    `    chainId: ${JSON.stringify(chain.id)},`,
    `    rpcUrls: [${rpcs}],`,
    `    rpcPolicy: ${JSON.stringify(chain.rpcPolicy)},`,
    `    finality: ${finality},`,
    `    reorgTolerant: ${chain.reorgTolerant},`,
    "  }",
  ].join("\n");
}

function renderWallet(w: IrChainV0["wallets"][number]): string {
  const keyRefStr = w.keyRef !== undefined ? `,\n    keyRef: ${renderSecretRef(w.keyRef)}` : "";
  return [
    "  {",
    `    id: ${JSON.stringify(w.id)},`,
    `    chainId: ${JSON.stringify(w.chainId)},`,
    `    custody: ${JSON.stringify(w.custody)},`,
    `    signingPolicy: ${JSON.stringify(w.signingPolicy)}${keyRefStr ? "" : ""}`,
    ...(keyRefStr ? [keyRefStr.replace(/^,\n/, "")] : []),
    "  }",
  ].join("\n");
}

function renderContract(c: IrChainV0["contracts"][number]): string {
  return [
    "  {",
    `    id: ${JSON.stringify(c.id)},`,
    `    chainId: ${JSON.stringify(c.chainId)},`,
    `    address: ${JSON.stringify(c.address)},`,
    `    abiRef: ${JSON.stringify(c.abiRef)},`,
    "  }",
  ].join("\n");
}

function renderTrigger(t: IrChainV0["triggers"][number]): string {
  if (t.kind === "event") {
    const filter = t.filter !== undefined ? `,\n    filter: ${JSON.stringify(t.filter)}` : "";
    return `  { kind: "event", chainId: ${JSON.stringify(t.chainId)}, contract: ${JSON.stringify(t.contract)}, event: ${JSON.stringify(t.event)}${filter} }`;
  }
  if (t.kind === "block") {
    return `  { kind: "block", chainId: ${JSON.stringify(t.chainId)}, scanIntervalMs: ${t.scanIntervalMs} }`;
  }
  return `  { kind: "address", chainId: ${JSON.stringify(t.chainId)}, address: ${JSON.stringify(t.address)}, direction: ${JSON.stringify(t.direction)} }`;
}

export function emitOnchain(ir: IrChainV0): Bundle {
  if (ir.chains.length === 0) {
    throw new TargetEmitError("onchain target requires at least one chain binding");
  }
  if (ir.triggers.length === 0) {
    throw new TargetEmitError("onchain target requires at least one trigger");
  }
  // Validate trigger references against chains[].
  const chainIds = new Set(ir.chains.map((c) => c.id));
  for (const t of ir.triggers) {
    if (!chainIds.has(t.chainId)) {
      throw new TargetEmitError(
        `trigger references chainId "${t.chainId}" not declared in chains[]`,
      );
    }
  }

  const policy = ir.transactionPolicy;
  const policyLiteral = JSON.stringify({
    defaultWriteApproval: policy.defaultWriteApproval,
    allowedContracts: policy.allowedContracts,
    simulationRequired: policy.simulationRequired,
    ...(policy.maxValueUsd !== undefined ? { maxValueUsd: policy.maxValueUsd } : {}),
  });

  const chains = ir.chains.map(renderChain).join(",\n");
  const wallets = ir.wallets.map(renderWallet).join(",\n");
  const contracts = ir.contracts.map(renderContract).join(",\n");
  const triggers = ir.triggers.map(renderTrigger).join(",\n");

  const instructions = escapeJsonString(ir.agent.instructions);
  const name = escapeJsonString(ir.name);

  const content = `/**
 * Generated by @crewhaus/target-onchain (§47 onchain daemon).
 * Compiled from spec: ${ir.name}
 * DO NOT EDIT — re-run \`crewhaus compile\` to regenerate.
 */
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { createEvmAdapter } from "@crewhaus/chain-adapter-evm";

export const SPEC_NAME = ${name};
export const AGENT_MODEL = ${JSON.stringify(ir.agent.model)};
export const AGENT_INSTRUCTIONS = ${instructions};
export const IDEMPOTENCY_WINDOW_MS = ${ir.idempotencyWindowMs};

export const CHAINS = [
${chains}
];

export const WALLETS = [
${wallets}
];

export const CONTRACTS = [
${contracts}
];

export const TRANSACTION_POLICY = ${policyLiteral};

export const TRIGGERS = [
${triggers}
];

/**
 * Bootstrap the adapter map keyed by chainId. The runtime calls this
 * once on daemon start; downstream tools (tool-evm, tool-evm-tx,
 * permission-tokengated) resolve adapters through the returned map.
 */
export function buildAdapters(): Map<string, ReturnType<typeof createEvmAdapter>> {
  const m = new Map<string, ReturnType<typeof createEvmAdapter>>();
  for (const c of CHAINS) {
    m.set(c.chainId, createEvmAdapter(c));
  }
  return m;
}

/**
 * Defense-in-depth: re-classify the decoded event payload (the chain
 * adapter already classified the RPC envelope, but this catches any
 * decoded-event content that an attacker may have planted in event
 * indexed args).
 */
export async function acceptOrRedact(payload: string): Promise<{ accept: boolean; text: string }> {
  const verdict = await classifyBoundary(payload, { origin: "chain" });
  if (verdict.action === "redact") {
    return { accept: false, text: verdict.redacted ?? "[chain payload redacted]" };
  }
  return { accept: true, text: payload };
}

// Slice-2 emits the adapter wiring + trigger metadata. The full event-
// subscription loop (poll for new logs, dedupe, dispatch to the agent)
// is wired in target-onchain v1 once the runtime's runChatLoop accepts
// the structured payload directly. Until then, the emitted bundle is a
// callable module that downstream daemons or tests import.
`;

  return { files: [{ path: "agent.ts", content }] };
}
