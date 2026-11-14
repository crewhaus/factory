# @crewhaus/control-service

The control plane's composition root ([#507](https://github.com/crewhaus/factory/issues/507),
[#513](https://github.com/crewhaus/factory/issues/513)). Every change a person makes to a harness,
from Home or from the CLI, is a **command**: its receipt is written before anything runs or answers,
so "accepted" is never "done", and a crash leaves a record that the next start can act on.

The design is in [module brief 325](https://github.com/crewhaus/docs/blob/main/module-briefs/325-control-service.md).
This package never enters a compiled harness and never imports `@crewhaus/hangar-server`.

```ts
import { currentLocalIdentity, wireControl } from "@crewhaus/control-service";

const control = wireControl(
  { hangarRoot, supervisorFor, drainRequest, identity: currentLocalIdentity(), probe: ops },
  { mode: "direct" },
);
await control.commands.recover({ harness: dir });
const answer = await control.commands.submit(
  { kind: "controls.stop", target: `home/harness/${hrn}`, ledger: { harness: dir }, via: "cli" },
  async () => ({ settle: { state: "succeeded" }, value: "stopped" }),
);
```

## Modes

| Mode | Head | What it adds |
|---|---|---|
| `server` | Home | at boot, after adoption and the job queue's restore: recovery over every registered harness and Home's own ledger |
| `direct` | the CLI | before its first change to a harness: recovery of that harness only |

A mode changes where calls land, never what a call does: `crewhaus daemon stop` and Home's Stop write
the same receipt to the same ledger.

## Receipts

| Ledger | Holds |
|---|---|
| `<harness>/.crewhaus/run/control/commands/` | every command about a harness, from either head |
| `<hangarRoot>/control/commands/` | commands about Home itself, and about a harness whose directory is gone |

A receipt holds ids, refs, keyed digests and states: never an argument, an input or a secret. Its
`actor` is the linked principal (`prn_…`) when Home's access records link the local user, and
otherwise `local:#<keyed digest>` under the ledger root's own key. Its `fingerprint` is a keyed digest
of the kind, the target, the path parameters, the query and the body without the fields the route
marks secret. Every row is the whole
receipt, folded by id through the `command` machine of `@crewhaus/control-contract`.

`commands.submit(request, effect?)`:

1. A request that is refused before acceptance writes nothing: an unknown kind, a malformed
   idempotency key or target, an unreadable digest key, a ledger that refuses the write.
2. The `accepted` receipt is written, stamped with the process that owns it (`executor`).
3. With an inline `effect`, it runs now and the receipt moves straight to its final state. It never
   writes `running`, so a refused start stays `rejected`.
4. Without one, the kind's registered executor runs it: `accepted → running → final`, through a
   compare-and-set, so two executors never both run one command.

## Idempotency

An `Idempotency-Key` value becomes the claim `idem/<first 32 hex of sha256(actor, harness, kind, key)>`;
the raw key is never written. The same key and fingerprint answer the original receipt as it stands,
also while it is still in flight, with `replayed: true`; a different request under the same key is
refused with `idempotency_key_reused`. A key is honoured for seven days: an older claim is removed on
the next touch. A claim whose receipt never landed is completed from the claim on the next touch.

## Recovery

`commands.recover(scope)` looks at `accepted` and `running` receipts whose executor is provably dead
(the mutating lease's rule, `holderProvablyDead`, or a start before the machine last booted):

| Found | Action |
|---|---|
| a job's receipt | the job queue moves it; Home settles one no job row names as `unknown` |
| a control a later control of the same family on the same harness overtook | `unknown`: superseded by a later command, never run |
| a daemon start accepted before the machine booted | `unknown`: not started, the machine restarted |
| `accepted`, safe to repeat | run again |
| `accepted`, not safe to repeat | reconcile: done → `succeeded`, not done → run again, else `unknown` |
| `running`, safe to repeat | the first recoverer to claim `recover/<cmd>` runs it again |
| `running`, not safe to repeat | reconcile: done → `succeeded`, not done → `failed`, else `unknown` |
| a legacy kind, or no executor | `unknown`: interrupted, needs a decision |

A control runs again only while it is the latest of its family on the harness: once an operator has
started, stopped or drained the daemon since, re-running an older daemon command would undo theirs.
The families are daemon (`controls.start`, `stop`, `restart`, `drain`), intake (`controls.pause`,
`resume`) and deployment (`controls.disable`, `enable`), each on its own; `controls.retire` is in
none, and has no executor, so it is never run again.

It answers `{redispatched, reconciled, unknown}`, and `runsInterrupted` when a run sweep closed a
run: the core's sweep marks a chat message a channel daemon accepted, and whose process died before
its turn started, `interrupted` (`reason: "not-processed"`, by `sys:reconcile`). Recovery writes, so
it never runs on a read.

Each head stamps its receipts with its own process (`executor: {pid, startedAt, host, head}`). Both
heads pass their probe through `withOwnStartTime`, which answers the head's own start time from its
clock, so stamping never starts a helper program; a stamp whose start time no probe confirmed carries
`probed: false`, and recovery judges it by its pid alone.

## Areas

`src/areas.ts` composes every area's executors and reconcilers for every head, with one commented
placeholder per area, each between blank lines. `wireControl` refuses a composition with a kind no
module declares, a kind registered twice, an area with no module, or a kind that is not safe to repeat
with an executor and no reconciler. The core registers daemon control: executors for `controls.start`,
`stop`, `restart` and `drain` (the supervisor's verbs with their default options, adopting a daemon
first) and one reconciler for start and restart (a live runfile whose daemon started after acceptance).
It also registers the decision service's kinds, `decisions.resolve`, `decisions.supersede`,
`rules.create` and `rules.revoke`: each executor observes what its receipt's target names (the
decision claim, a request's row, a rule's row) and settles by it, and acts again on nothing. They act
on records alone, so their area declares them `unsupervised` and they run with no supervisor.

## Operator controls and retire

`applyOperatorControl(ctx, {kind, quiet?, reload?})` is the only writer of a harness's operator record
(`.crewhaus/run/control/operator.json`) for `controls.pause`, `resume`, `disable` and `enable`: the
block it writes carries the receipt's stored actor (`by`) and id (`cmd`). Writing the record is the
effect, so the receipt settles `succeeded` once it is written; then the head's control client `reload`
asks a running daemon to read it, and the receipt's daemon effect says what it saw (`confirmed`,
`applies within a second`, `applies when it starts`, or `recorded, not enforced` for a build without
the route). A record that cannot be read is never written: the receipt is `failed`, `unavailable`.
The same function is the four kinds' executor (records only, `unsupervised`): run by recovery it leaves
a block that already names the receipt alone, and otherwise writes a pause with the standard notice,
since a receipt keeps no argument. `recordDesired(dir, desired)` records whether the harness should be
running, for the recovery after a reboot; both heads lend it to their supervisors.

`retireSteps({harnessDir, receipt, hangarRoot, stop, stopDaemon?, ...})` is retire's own part: stop
(with `--stop`) and disable, cancel queued runs (taking each run's claim first), expire open approvals
and unspent grants with reason `retired`, revoke standing rules, run every area's retire revoker, then,
after the archive, disable the harness again in its live directory (the archive took its operator
record), append `harness.retired` to `<hangarRoot>/control/lifecycle.jsonl` and mark the registry row
archived. An area registers a revoker in `AreaRuntime.retireRevokers`;
`retireRevokers(areas)` lists them in composition order, and `wireControl` refuses a name registered
twice. `controls.retire`'s reconciler reads the lifecycle record.

## Decisions and standing rules

`decisions` is the one way a tool approval, or a request to a harness's owner, is decided, from
Home or the CLI. The surface says who asks (`DecisionActor`): Home's signed-in principal, the CLI's
local user (who counts as the member Home's access records link them to), or nobody; a display label
is shown with the decision and carries no authority. On a harness with an approver projection a
decision counts only from a member whose class reaches the request's (session-store's
`principalAuthorizer`). The service writes no receipt itself: Home's receipts middleware and the
CLI's `commands.submit` do. A tool approval's step is `resolveToolApproval`
(`@crewhaus/control-service/approval-resolve`), which a channel daemon's buttons call too: its
imports reach no Home package, so a compiled daemon can load it.

A grant with `always` also makes a standing rule: the narrowest allow that covers the approved call
(permission-engine's `narrowPatternFor`), for 30 days unless `days` says otherwise, kept as a row in
`.crewhaus/run/control/standing-rules.jsonl` beside its `.crewhaus/settings.json` entry. Only the
owner makes one; a member's `always` grants once and files a `dec_` request the owner answers.
`rules` lists live rules, waiting requests and whole-tool allows no record keeps, and ends a rule.
`harnessForSessionRoot` finds the harness a session root found through the environment belongs to,
and `settingsWriteClass` says which class a settings change needs.

## Jobs

`jobs.wrapStore(store)` wraps the job queue's store, so a command carried out by a queued job moves
with it: running, done, failed, cancelled (a running command that is cancelled is `failed`, outcome
`cancelled`), and interrupted (`unknown`; a read-only job's is `failed`). A job row carries the
command's id and who queued it (`commandId`, `by`).

## Exits

A CLI command refused by the control plane exits through `EXIT_FOR_ERROR` in `@crewhaus/control-contract`:
the band 50-56 of `@crewhaus/errors`' `EXIT_CODES`. A `rejected` receipt exits 55, or 38 when its outcome
is `disabled`.

## Limits

- A harness run from a directory with no `.crewhaus/run/` takes no mutating lease from the CLI; the CLI
  never creates that tree just to take one.
- Recovery cannot judge a process on another host, so a receipt stamped elsewhere is left alone.
