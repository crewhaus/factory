/**
 * The core's sweeps: what Home's tick keeps true while Home runs, in a window or as the
 * installed service. Each runs under its own system principal (`scheduler-host.ts`), and
 * none of them submits a job.
 *
 * | Sweep | Every | What it keeps true |
 * |---|---|---|
 * | `reconcile` | 10 s | a daemon started from a terminal is attached (a stale runfile is cleared); commands whose process died are recovered; `unknown` receipts settle by what their reconciler observes; approver lists follow group moves and grant ends |
 * | `notifications` | 10 s | the rules people turned on are delivered, on the sinks they chose |
 * | `standing-rules` | 10 s | a standing rule past its end is ended |
 * | `claims` | 1 h | an idempotency key older than seven days can be used again |
 * | `inbound` | 1 h | a delivery's raw body is kept only while its receipt is open |
 * | `projector` | 2 s | every harness's read models under `cache/index/` follow its records, nudged harnesses first; each change they show is one line of the fleet's change log, which keeps its newest segments |
 *
 * Each step of `reconcile` is isolated: one that throws is warned about and the next runs.
 */
import type { AccessHarness } from "@crewhaus/access-control";
import { refreshApproverProjections } from "@crewhaus/access-control";
import {
  CORE_PROJECTIONS,
  type ControlService,
  type Projection,
  commandsLedgerOf,
  endExpiredRules,
  expireIdempotencyClaims,
  projectOnce,
  workspaceCommandsLedger,
} from "@crewhaus/control-service";
import { sweepInboundRecords } from "./ingress";
import type { Sweep } from "./scheduler-host";

/** What Home lends its sweeps. */
export type HomePorts = {
  readonly hangarRoot: string;
  /** Every registered harness whose directory is there, as the sweeps visit them. */
  liveHarnesses(): ReadonlyArray<{ readonly id: string; readonly dir: string }>;
  /** Every registered harness with the groups it is in now, for the approver lists. */
  accessHarnesses(): readonly AccessHarness[];
  /** Attach a daemon this Home does not hold (a no-op without a runfile, or with a pid held). */
  adoptIfRunfile(harnessDir: string): Promise<void>;
  readonly control: Pick<ControlService["commands"], "recover" | "reconcile">;
  /** One pass of a harness's delegation rules, as the scheduler. Never from a read. */
  readonly delegations: Pick<ControlService["delegations"], "apply">;
  /** Evaluate the notification rules once and deliver what is due. */
  notificationsTick(): void;
  /** The projections the projector keeps; the core's when absent. */
  readonly projections?: readonly Projection<unknown>[];
};

/** Run one step, warning on a throw so the next step still runs. */
async function step(
  name: string,
  warn: (message: string) => void,
  run: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    warn(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const reconcile: Sweep<HomePorts> = {
  name: "reconcile",
  everyMs: 10_000,
  run: async ({ home, now, warn }) => {
    await step("adoption", warn, async () => {
      for (const harness of home.liveHarnesses()) {
        await step(`adoption of ${harness.id}`, warn, () => home.adoptIfRunfile(harness.dir));
      }
    });
    await step("command recovery", warn, () => home.control.recover("all"));
    await step("reconciliation", warn, () => home.control.reconcile("all"));
    await step("approver lists", warn, async () => {
      const answer = await refreshApproverProjections(home.hangarRoot, {
        harnesses: home.accessHarnesses(),
        now,
      });
      for (const failure of answer.projections.failed) {
        warn(`the approver list of ${failure.harness} was not updated: ${failure.reason}`);
      }
    });
  },
};

const notifications: Sweep<HomePorts> = {
  name: "notifications",
  everyMs: 10_000,
  run: ({ home }) => home.notificationsTick(),
};

const standingRules: Sweep<HomePorts> = {
  name: "standing-rules",
  everyMs: 10_000,
  run: async ({ home, now, warn }) => {
    for (const harness of home.liveHarnesses()) {
      await step(`the rules of ${harness.id}`, warn, () => endExpiredRules(harness.dir, now));
    }
  },
};

const claims: Sweep<HomePorts> = {
  name: "claims",
  everyMs: 3_600_000,
  run: async ({ home, now, warn }) => {
    const ledgers = [
      ...home.liveHarnesses().map((harness) => ({
        name: harness.id,
        ledger: commandsLedgerOf(harness.dir),
      })),
      { name: "Home", ledger: workspaceCommandsLedger(home.hangarRoot) },
    ];
    for (const { name, ledger } of ledgers) {
      await step(`the claims of ${name}`, warn, async () => {
        const swept = await expireIdempotencyClaims(ledger, now);
        if (swept.truncated) warn(`the claims of ${name} are more than one sweep lists`);
      });
    }
  },
};

const inbound: Sweep<HomePorts> = {
  name: "inbound",
  everyMs: 3_600_000,
  run: async ({ home, now, warn }) => {
    const swept = await sweepInboundRecords(home.hangarRoot, now, warn);
    if (swept.truncated) warn("the inbound records are more than one sweep looks at");
  },
};

const projector: Sweep<HomePorts> = {
  name: "projector",
  everyMs: 2_000,
  run: async ({ home, now, warn }) => {
    const report = await projectOnce({
      hangarRoot: home.hangarRoot,
      harnesses: home.liveHarnesses(),
      projections: home.projections ?? CORE_PROJECTIONS,
      now,
    });
    for (const failure of report.failed) {
      warn(`the read model ${failure.at} was not updated: ${failure.reason}`);
    }
  },
};

/** The core's sweeps, in the order they run on a tick. */
export const CORE_SWEEPS: readonly Sweep<HomePorts>[] = [
  reconcile,
  notifications,
  standingRules,
  claims,
  inbound,
  projector,
];
