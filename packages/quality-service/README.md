# @crewhaus/quality-service

Change records for a harness's spec, graders and cases
([#519](https://github.com/crewhaus/factory/issues/519),
[module brief 330](https://github.com/crewhaus/docs/blob/main/module-briefs/330-quality-service.md)).
A change is proposed, checked against the harness's eval history (and its dataset's holdout,
when there is one), decided by a person through a `dec_` decision, adopted through the
sanctioned writer, and watched once its build is active. `crewhaus changes` is its command
line. It never enters a compiled harness, and a test fails if an emitter names it.

```ts
import { checkChange, createChange } from "@crewhaus/quality-service";

const filed = await createChange({
  harnessDir,
  kind: "spec",
  source: "manual",
  spec: "crewhaus.yaml",
  graders: "eval/graders.yaml",
  dataset: "registry:support",
  baseText,
  candidateText,
  actor, // a stored actor: prn_…, local:#… or sys:…
  now: () => Date.now(),
});
const checked = await checkChange({ harnessDir, chg: filed.row.id, runners, actor, now });
```

## Records

| Where | What |
|---|---|
| `.crewhaus/run/control/changes.jsonl` | one row per move, on control-contract's `change` machine: ids, keyed digests, closed codes, a stored actor and times, never a diff or a case |
| `.crewhaus/run/control/decisions/` | the `change-adoption` decision a passing check opens |
| `.crewhaus/proposals/<chg>/` | the change's content: the file as it was and as proposed, `patch.json`, the rendered changelog entry and PR body, and each check's evidence and runs (directory `0700`, files `0600`) |

Every move is a compare-and-set, so two writers never both move a change. A read (`readChanges`,
`effectiveChangeState`) takes no lock and writes nothing; a row whose move the machine does not
allow is reported, never dropped.

## The check

`checkChange` takes its eval and its regrade as functions (`CheckRunners`), so this package
imports no command line.

- **spec**: a base run and a candidate run on the same cases. Tool results replay from the
  lineage's recorded run when it recorded them; a harness with a tool that writes outside the
  process and no recording needs a live check a maintainer confirms. When the dataset version has
  a holdout, both sides run on it too: each read is counted in the dataset's use ledger, and a base
  holdout run an earlier change made is reused when the base, the holdout version and the
  instrument all match. The holdout runs replay the lineage's recording only when it holds entries
  for the holdout's cases; otherwise they run live, and on a harness with a tool that writes
  outside the process only when a maintainer confirmed a live check. The plan `crewhaus changes
  check` prints says which.
- **graders**: the lineage's recorded answers regraded with the base graders and the candidate's;
  no agent call.
- **dataset**: only the added cases run.

`promotionCheck(base, candidate)` is pure: the strict run-history gate, plus a failure for any case
the base measured that the candidate abstained on or left out. Check runs stay under the change's directory: they
are never in the run history and never pinned.

## What a decision binds

`patchDigest` is a keyed digest over the change's kind, the file it was proposed against, the
proposed file and the spec, graders and dataset paths `patch.json` names; `evidenceDigest` covers
the check's evidence. The check, adoption and rollback each read the content back and refuse
(`binding-changed`) unless it is what those digests record, and `patch.json`'s paths must stay
inside the harness. So what was checked, what the decision binds and what is written are the same
bytes.

## Adopting

`adoptChange` re-checks at the moment it consumes the grant: the decision is granted and bound to
this change, its content and evidence are what the row records, what that content touches needs
no higher class than the decision's, the file is still the revision the check read, the instrument
(graders, judge model, judge calibration and plugin graders, from an injected `instrumentNow`) is
the one the check measured with, the person adopting still holds the decision's class, and a
change with no held-out check is adopted only with `withoutHoldout`. An instrument that cannot be
determined is a refusal. A refusal leaves the grant unspent; a write that fails after the grant is
used closes the change (`superseded`) so it can be proposed again. A change to a protected bar, the intent, a security surface or
spending needs the owner; any other a maintainer. Adopting never activates:
`crewhaus deploy activate` does, and the next writer records the activation and starts the watch.
`rollbackChange` restores the recorded base, refusing with the diff when the file moved since.

A check holds the harness's mutating lease while it runs. `observeChanges`, which every `changes`
writer runs first, moves a `checking` change whose check was interrupted to `failed` (it can be
checked again), and reads the SLO mitigation records the run path wrote to decide a watch.
