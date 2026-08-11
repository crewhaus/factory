/**
 * Loop contract 0.4 (Batch C, G11) — the channel-generic pending-approval
 * surface.
 *
 * When a tool permission resolves to `ask` on a NON-interactive surface with
 * `permissions.ask_mode: "pause"` (the default), the run no longer collapses
 * the ask to a deny: it persists a {@link PendingApproval}, surfaces it to a
 * human (a Slack Approve/Deny message, or a text fallback for adapters without
 * interactive buttons), and PARKS until the decision arrives out-of-band (a
 * Slack button, the `crewhaus approvals grant|deny` CLI verb, or any other
 * approval surface writing to the same store).
 *
 * This module is the channel-generic half — the store contract, an in-memory
 * default store, and the park/resolve orchestration primitives. It is
 * deliberately dependency-free: every collaborator (the Slack block-kit
 * builder, the durable audit sink, the trace bus) is reached through a MINIMAL
 * STRUCTURAL SEAM so this package neither imports a specific adapter nor the
 * audit-log/trace-event-bus packages (mirrors the `JustificationAuditSink`
 * seam runtime-core declares to avoid a dependency cycle). The Slack-specific
 * block-kit + interaction parsing lives in `@crewhaus/channel-adapter-slack`;
 * the daemon wiring (gateway action route, boot-time store construction) is
 * emitted by `@crewhaus/target-channel-bot`.
 *
 * Catalog layer: R8 (channel boundary), G11 (generalized pending-approval).
 */

/** The two terminal decisions an approval can reach. */
export type ApprovalDecision = "grant" | "deny";

/** Lifecycle status: `pending` until a decision is recorded. */
export type ApprovalStatus = "pending" | ApprovalDecision;

/**
 * The fields a caller supplies when parking a new approval. `context` is an
 * OPAQUE channel-resume blob — the generated session-router stashes the
 * inbound event it needs to re-drive + reply here, and this package never
 * inspects it (keeping it free of any adapter's event type).
 */
export type NewPendingApproval = {
  readonly toolName: string;
  readonly inputPreview: string;
  readonly surface: string;
  readonly sessionId: string;
  readonly context?: unknown;
};

/** A parked approval as stored: the {@link NewPendingApproval} plus identity,
 *  status, and decision provenance. */
export type PendingApproval = {
  readonly id: string;
  readonly toolName: string;
  readonly inputPreview: string;
  readonly surface: string;
  readonly sessionId: string;
  readonly context?: unknown;
  readonly status: ApprovalStatus;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 decision timestamp (present once resolved). */
  readonly decidedAt?: string;
  /** Free-form deciding identity (e.g. `"cli"`, `"slack:U0123"`). */
  readonly decidedBy?: string;
  /**
   * #383 — present (true) when a `grant` was recorded as a STANDING allow
   * (the Slack "Always allow" button / `crewhaus approvals grant --always`):
   * the resolving surface also persists an `alwaysAllow` permission rule for
   * the tool, so future calls skip the approval flow entirely.
   */
  readonly always?: boolean;
};

/** Filter for {@link ApprovalStore.list}. */
export type ApprovalListFilter = {
  readonly status?: ApprovalStatus;
  readonly sessionId?: string;
};

/**
 * The durable seam a parked run and every approval surface (Slack button, CLI
 * verb, cf-worker) share. A single store instance is the rendezvous point: the
 * run persists+parks; a surface resolves; the run (or the channel resumer)
 * reads the decision back.
 *
 * A production, cross-process backend (session-store / SQLite) is downstream;
 * {@link InMemoryApprovalStore} is the single-process default the emitted
 * daemon wires today (the gateway action route and the parked turn live in the
 * same process).
 */
export interface ApprovalStore {
  /** Persist a new pending approval, minting its id + `createdAt`. */
  put(input: NewPendingApproval): Promise<PendingApproval>;
  /** Fetch by id, or `null` when unknown. */
  get(id: string): Promise<PendingApproval | null>;
  /**
   * Record a terminal decision. Returns the updated record ONLY when THIS call
   * transitioned it `pending` → decided; returns `null` when the id is unknown
   * OR was already decided. That makes resolution IDEMPOTENT at the effect
   * level — a duplicate resolve (a Slack button retry, two operators racing the
   * CLI verb) is a no-op the caller can treat as "nothing to ACK", so the FIRST
   * decision wins and the audit/trace/resume fire exactly once. Read the final
   * decision of an already-resolved approval with {@link get}.
   * `opts.always` marks a `grant` as a standing allow (#383).
   */
  resolve(
    id: string,
    decision: ApprovalDecision,
    by: string,
    opts?: { readonly always?: boolean },
  ): Promise<PendingApproval | null>;
  /** All approvals matching the filter (newest first), or all when unfiltered. */
  list(filter?: ApprovalListFilter): Promise<readonly PendingApproval[]>;
  /**
   * Resolve when the approval reaches a terminal decision. In a single-process
   * daemon this settles the instant `resolve()` runs (the action webhook, the
   * in-process CLI verb, or the text-fallback grant). An already-resolved id
   * settles immediately; an unknown id rejects.
   */
  waitFor(id: string): Promise<ApprovalDecision>;
}

/** Minimal durable-audit seam — structurally satisfied by `@crewhaus/audit-log`'s
 *  `AuditLog` (its `append({ kind, payload })`). Declared here, like
 *  runtime-core's `JustificationAuditSink`, so this package takes no audit-log
 *  dependency. `kind` is a plain string: the G11 approval kinds are not (yet)
 *  in audit-log's `AuditKind` union, and `openAuditLog` writes the kind
 *  verbatim without validating it. */
export type ApprovalAuditSink = {
  append(record: { readonly kind: string; readonly payload: unknown }): Promise<unknown>;
};

/** The two G11 trace events, structurally mirroring `@crewhaus/trace-event-bus`'s
 *  `ApprovalRequestedEvent` / `ApprovalResolvedEvent` (minus the envelope, which
 *  the bus stamps). A publish seam rather than a bus import keeps this package
 *  dependency-free; the caller passes `bus.publish({ ...bus.envelope(), ...ev })`. */
export type ApprovalTraceEvent =
  | {
      readonly kind: "approval_requested";
      readonly approvalId: string;
      readonly toolName: string;
      readonly surface: string;
    }
  | {
      readonly kind: "approval_resolved";
      readonly approvalId: string;
      readonly decision: ApprovalDecision;
      readonly by: string;
      /** #383 — true when the grant was recorded as a standing allow. */
      readonly always?: boolean;
    };

export type ApprovalTracePublish = (event: ApprovalTraceEvent) => void;

export type InMemoryApprovalStoreOptions = {
  /** Clock seam (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Id generator seam (tests). Defaults to `appr_<24 hex>`. */
  readonly genId?: () => string;
  /**
   * Maximum records retained. When exceeded, the OLDEST already-RESOLVED
   * records are evicted first (pending approvals are never evicted). Defaults
   * to 10_000.
   */
  readonly capacity?: number;
};

/**
 * In-process {@link ApprovalStore} default — a bounded map plus a per-id waiter
 * list so {@link waitFor} settles the moment {@link resolve} runs. Mirrors the
 * `InMemoryDedupStore` pattern from `@crewhaus/durable-state`: volatile, so a
 * daemon restart forgets parked approvals (a durable backend is the downstream
 * upgrade). Adequate for the single-process daemon where the parked turn and
 * the gateway action route share one heap.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, PendingApproval>();
  private readonly waiters = new Map<string, Array<(d: ApprovalDecision) => void>>();
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly capacity: number;

  constructor(opts: InMemoryApprovalStoreOptions = {}) {
    this.now = opts.now ?? ((): number => Date.now());
    this.genId = opts.genId ?? defaultGenId;
    this.capacity = opts.capacity ?? 10_000;
  }

  put(input: NewPendingApproval): Promise<PendingApproval> {
    const record: PendingApproval = {
      id: this.genId(),
      toolName: input.toolName,
      inputPreview: input.inputPreview,
      surface: input.surface,
      sessionId: input.sessionId,
      ...(input.context !== undefined ? { context: input.context } : {}),
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
    };
    this.records.set(record.id, record);
    this.evictIfNeeded();
    return Promise.resolve(record);
  }

  get(id: string): Promise<PendingApproval | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  resolve(
    id: string,
    decision: ApprovalDecision,
    by: string,
    opts?: { readonly always?: boolean },
  ): Promise<PendingApproval | null> {
    const existing = this.records.get(id);
    if (existing === undefined) return Promise.resolve(null);
    // Idempotent: the first decision wins. A re-resolve is a no-op that returns
    // null (nothing to ACK) and never re-notifies waiters or re-fires effects.
    if (existing.status !== "pending") return Promise.resolve(null);
    const resolved: PendingApproval = {
      ...existing,
      status: decision,
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: by,
      // #383 — a standing allow only ever rides on a grant.
      ...(decision === "grant" && opts?.always === true ? { always: true } : {}),
    };
    this.records.set(id, resolved);
    const waiters = this.waiters.get(id);
    if (waiters !== undefined) {
      this.waiters.delete(id);
      for (const w of waiters) w(decision);
    }
    return Promise.resolve(resolved);
  }

  list(filter: ApprovalListFilter = {}): Promise<readonly PendingApproval[]> {
    const out: PendingApproval[] = [];
    // Map preserves insertion order (oldest → newest); collect matches then
    // reverse for newest-first. Insertion order is the reliable chronology —
    // `createdAt` has only millisecond resolution, so two approvals minted in
    // the same tick would otherwise tie.
    for (const r of this.records.values()) {
      if (filter.status !== undefined && r.status !== filter.status) continue;
      if (filter.sessionId !== undefined && r.sessionId !== filter.sessionId) continue;
      out.push(r);
    }
    out.reverse();
    return Promise.resolve(out);
  }

  waitFor(id: string): Promise<ApprovalDecision> {
    const existing = this.records.get(id);
    if (existing === undefined) {
      return Promise.reject(new Error(`unknown approval: ${id}`));
    }
    if (existing.status !== "pending") return Promise.resolve(existing.status);
    return new Promise<ApprovalDecision>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  private evictIfNeeded(): void {
    if (this.records.size <= this.capacity) return;
    // Evict oldest RESOLVED records first (insertion order == roughly age);
    // never evict a pending approval, or a park would lose its rendezvous.
    for (const [id, r] of this.records) {
      if (this.records.size <= this.capacity) break;
      if (r.status !== "pending") this.records.delete(id);
    }
  }
}

function defaultGenId(): string {
  // 24 hex chars of randomness — id collisions are the store's rendezvous key.
  let hex = "";
  for (let i = 0; i < 3; i++) {
    hex += Math.floor(Math.random() * 0x1_0000_0000)
      .toString(16)
      .padStart(8, "0");
  }
  return `appr_${hex}`;
}

/** Default one-line preview of a tool's input for the approval prompt — JSON,
 *  truncated, and never throwing on a non-serializable input. */
export function previewApprovalInput(input: unknown, max = 200): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    text = String(input);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The channel-generic text every non-interactive adapter falls back to when it
 *  cannot render Approve/Deny buttons. */
export function approvalFallbackText(approvalId: string): string {
  return `approval pending — run \`crewhaus approvals grant ${approvalId}\` (or \`deny\`) to decide; add \`--always\` to allow the tool from now on`;
}

/**
 * Surface a parked approval to the human. When `postInteractive` is provided
 * (the adapter supports Approve/Deny buttons — Slack), it renders the
 * interactive message; otherwise it sends {@link approvalFallbackText} through
 * `sendText`, which every adapter supports. Returns whether the interactive
 * path was taken plus the posted message ts (when the adapter reports one).
 */
export async function postApprovalPrompt(args: {
  readonly pending: PendingApproval;
  readonly sendText: (text: string) => Promise<void>;
  readonly postInteractive?: (approval: {
    readonly approvalId: string;
    readonly toolName: string;
    readonly inputPreview: string;
    readonly surface: string;
  }) => Promise<{ messageTs?: string }>;
}): Promise<{ interactive: boolean; messageTs?: string }> {
  const p = args.pending;
  if (args.postInteractive !== undefined) {
    const res = await args.postInteractive({
      approvalId: p.id,
      toolName: p.toolName,
      inputPreview: p.inputPreview,
      surface: p.surface,
    });
    return {
      interactive: true,
      ...(res.messageTs !== undefined ? { messageTs: res.messageTs } : {}),
    };
  }
  await args.sendText(approvalFallbackText(p.id));
  return { interactive: false };
}

/**
 * Build the `askApproval` prompter the runtime calls when a tool resolves to
 * `ask` on a paused surface — the exact `(toolName, input) => Promise<boolean>`
 * shape runtime-core's permission loop expects. It parks a {@link
 * PendingApproval}, publishes `approval_requested`, surfaces it via `notify`
 * (Slack buttons or text fallback), then AWAITS the store's decision and maps
 * `grant` → proceed / `deny` → block.
 *
 * NOTE (downstream seam): runtime-core does not yet accept an injected
 * `askApproval` in single-turn/channel mode (it wires one only in REPL mode);
 * the single-turn park path + resume token are the runtime half of G11. This
 * prompter is the channel half it will call — and the unit of the park→resume
 * e2e, driven directly against a scripted store.
 */
export function createApprovalPrompter(deps: {
  readonly store: ApprovalStore;
  readonly surface: string;
  readonly sessionId: string;
  /** Surface the parked approval to the human (usually `postApprovalPrompt`). */
  readonly notify: (pending: PendingApproval) => Promise<void>;
  readonly publish?: ApprovalTracePublish;
  readonly previewInput?: (input: unknown) => string;
  readonly context?: unknown;
}): (toolName: string, input: unknown) => Promise<boolean> {
  const preview = deps.previewInput ?? previewApprovalInput;
  return async (toolName: string, input: unknown): Promise<boolean> => {
    const pending = await deps.store.put({
      toolName,
      inputPreview: preview(input),
      surface: deps.surface,
      sessionId: deps.sessionId,
      ...(deps.context !== undefined ? { context: deps.context } : {}),
    });
    deps.publish?.({
      kind: "approval_requested",
      approvalId: pending.id,
      toolName,
      surface: deps.surface,
    });
    await deps.notify(pending);
    const decision = await deps.store.waitFor(pending.id);
    return decision === "grant";
  };
}

/**
 * Resolve a parked approval from an out-of-band decision (a Slack button, a CLI
 * verb). Records the decision in the store (idempotent — the first decision
 * wins), publishes `approval_resolved`, and appends a durable audit record when
 * a sink is wired. Returns the resolved record, or `null` when the id is
 * unknown. The caller (the gateway action route) ACKs in-thread and, on
 * `grant`, drives the resume.
 */
export async function resolveApproval(deps: {
  readonly store: ApprovalStore;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly by: string;
  /** #383 — record a `grant` as a standing allow (Slack "Always allow"). */
  readonly always?: boolean;
  readonly publish?: ApprovalTracePublish;
  readonly auditSink?: ApprovalAuditSink;
}): Promise<PendingApproval | null> {
  const always = deps.decision === "grant" && deps.always === true;
  const resolved = await deps.store.resolve(
    deps.approvalId,
    deps.decision,
    deps.by,
    always ? { always: true } : undefined,
  );
  if (resolved === null) return null;
  deps.publish?.({
    kind: "approval_resolved",
    approvalId: resolved.id,
    decision: deps.decision,
    by: deps.by,
    ...(always ? { always: true } : {}),
  });
  if (deps.auditSink !== undefined) {
    await deps.auditSink.append({
      kind: "approval_resolved",
      payload: {
        schemaVersion: 1,
        approvalId: resolved.id,
        toolName: resolved.toolName,
        surface: resolved.surface,
        sessionId: resolved.sessionId,
        decision: deps.decision,
        by: deps.by,
        ...(always ? { always: true } : {}),
        ...(resolved.decidedAt !== undefined ? { decidedAt: resolved.decidedAt } : {}),
      },
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Loop contract 0.4 (G11) — bridging the channel store to the RUNTIME store.
// ---------------------------------------------------------------------------

/**
 * The slice of `@crewhaus/session-store`'s `PendingApprovalStore` this bridge
 * needs. Declared STRUCTURALLY rather than imported so `channel-adapter-base`
 * gains no dependency on the session store (and no cycle): the emitted daemon
 * injects the concrete store it already builds for `runChatLoop`.
 */
export type RuntimeApprovalRecord = {
  readonly id: string;
  readonly toolName: string;
  readonly inputHash: string;
  readonly input: unknown;
  readonly runId: string;
  readonly sessionId: string;
  readonly surface: string;
  readonly createdAt: string;
  readonly decision?: "grant" | "deny";
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly consumedAt?: string;
  /** #383 — the grant is a standing allow (unconsumed; a rule covers the tool). */
  readonly always?: boolean;
};

export type RuntimeApprovalStoreLike = {
  persist(approval: RuntimeApprovalRecord): Promise<void>;
  get(toolName: string, inputHash: string): Promise<RuntimeApprovalRecord | null>;
  resolve(
    id: string,
    decision: ApprovalDecision,
    by: string,
    opts?: { readonly always?: boolean },
  ): Promise<RuntimeApprovalRecord | null>;
  list(): Promise<RuntimeApprovalRecord[]>;
};

export type RuntimeBackedApprovalStoreOptions = {
  /** Mints ids for `put()`. Defaults to the runtime's `appr_<16 hex>` shape. */
  readonly genId?: () => string;
  /** Poll interval for `waitFor`. Defaults to 1s. */
  readonly waitForPollMs?: number;
  readonly now?: () => Date;
};

function toChannelApproval(r: RuntimeApprovalRecord): PendingApproval {
  return {
    id: r.id,
    toolName: r.toolName,
    // The runtime keeps the raw input; the channel surface only ever renders a
    // preview, and rendering it here (rather than storing it) keeps the raw
    // value off the Slack path unless a caller asks for it.
    inputPreview: previewApprovalInput(r.input),
    surface: r.surface,
    sessionId: r.sessionId,
    status: r.decision ?? "pending",
    createdAt: r.createdAt,
    ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
    ...(r.decidedBy !== undefined ? { decidedBy: r.decidedBy } : {}),
    ...(r.always === true ? { always: true } : {}),
  };
}

/**
 * An {@link ApprovalStore} backed by the RUNTIME's pending-approval store.
 *
 * The channel surface and the runtime kept two different stores, and the
 * runtime's was the only one anything wrote to — so the Slack approve/deny
 * flow queried an empty map and could never prompt, let alone resume. This is
 * the adapter that makes them one store.
 *
 * It has to be the runtime's store underneath, not the reverse: a granted
 * approval is consumed when the re-driven turn re-asks runtime-core, which
 * consults ONLY its own store, keyed `(toolName, inputHash)`. A decision
 * recorded anywhere else is a decision the agent never sees.
 *
 * Three semantics worth knowing, each load-bearing:
 *
 *   - `resolve` returns `null` when the record was ALREADY decided. The
 *     runtime's own `resolve` overwrites and returns the record, but the
 *     gateway's `/actions` route treats a non-null return as "this call
 *     transitioned it" and uses it to decide whether to ACK Slack and re-drive
 *     the turn. Passing the runtime's return through directly would double-ACK
 *     and double-drive on a Slack retry, which is a real duplicate-side-effect
 *     bug, not a cosmetic one.
 *   - ids stay in the runtime's `appr_<16 hex>` space. The channel store minted
 *     24 hex, which `session-store.resolve()` rejects outright and which
 *     `crewhaus approvals grant` — the command the Slack prompt itself tells
 *     the operator to run — will not accept either.
 *   - it is DURABLE. The in-memory store lost every park on daemon restart and
 *     shared nothing between processes, so a bot restarted mid-approval left a
 *     human staring at buttons wired to nothing.
 */
export function createRuntimeBackedApprovalStore(
  runtime: RuntimeApprovalStoreLike,
  opts: RuntimeBackedApprovalStoreOptions = {},
): ApprovalStore {
  const now = opts.now ?? (() => new Date());
  const waitForPollMs = opts.waitForPollMs ?? 1_000;
  const genId =
    opts.genId ??
    (() => {
      // Mirror of the runtime's `appr_` + 16 lowercase hex. Kept local rather
      // than imported so this module stays dependency-free.
      let out = "appr_";
      for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
      return out;
    });

  async function byId(id: string): Promise<RuntimeApprovalRecord | null> {
    for (const r of await runtime.list()) if (r.id === id) return r;
    return null;
  }

  return {
    /**
     * Present for interface parity. Production parks are written by
     * runtime-core itself, which has the real `inputHash` — the key a grant is
     * later matched on. A record put here carries a hash derived from the
     * preview instead, so granting it would NOT unblock a real tool call.
     */
    async put(input: NewPendingApproval): Promise<PendingApproval> {
      const record: RuntimeApprovalRecord = {
        id: genId(),
        toolName: input.toolName,
        inputHash: `preview:${input.inputPreview}`,
        input: input.inputPreview,
        runId: "run_channel",
        sessionId: input.sessionId,
        surface: input.surface,
        createdAt: now().toISOString(),
      };
      await runtime.persist(record);
      return toChannelApproval(record);
    },

    async get(id: string): Promise<PendingApproval | null> {
      const r = await byId(id);
      return r === null ? null : toChannelApproval(r);
    },

    async resolve(
      id: string,
      decision: ApprovalDecision,
      by: string,
      opts?: { readonly always?: boolean },
    ): Promise<PendingApproval | null> {
      // Read BEFORE writing: the pending→decided transition is what the
      // gateway keys its ACK + resume on, and the runtime store will happily
      // overwrite a decision without telling us it was already made.
      const before = await byId(id);
      if (before === null || before.decision !== undefined) return null;
      const after = await runtime.resolve(id, decision, by, opts);
      return after === null ? null : toChannelApproval(after);
    },

    async list(filter?: ApprovalListFilter): Promise<readonly PendingApproval[]> {
      const all = (await runtime.list()).map(toChannelApproval);
      const matched = all.filter(
        (a) =>
          (filter?.status === undefined || a.status === filter.status) &&
          (filter?.sessionId === undefined || a.sessionId === filter.sessionId),
      );
      // Newest-first, matching InMemoryApprovalStore's contract.
      return matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    /**
     * Polled, because the runtime store is a file other processes also write —
     * there is no in-process waiter to hook. Unused by the emitted daemon
     * (which resolves through the gateway route), but the interface promises
     * it, and an unknown id must reject rather than hang forever.
     */
    async waitFor(id: string): Promise<ApprovalDecision> {
      if ((await byId(id)) === null) {
        throw new Error(`waitFor: unknown approval "${id}"`);
      }
      for (;;) {
        const r = await byId(id);
        if (r === null) throw new Error(`waitFor: approval "${id}" disappeared`);
        if (r.decision !== undefined) return r.decision;
        await new Promise((resolve) => setTimeout(resolve, waitForPollMs));
      }
    },
  };
}
