/**
 * A daemon in the middle of a turn: run as a real child by a supervisor in
 * `cross-surface.test.ts`, never imported. It writes its run's rows through the run ledger's
 * own writer, the `running` row carrying the execution the supervisor started it as, says
 * so in the `marker` file, and then waits until it is killed.
 *
 * Environment: `CREWHAUS_EXECUTION_ID` (set by the supervisor), `MID_TURN_RUN` (the run's
 * id) and `MID_TURN_MARKER`.
 */
import { writeFileSync } from "node:fs";
import { append, runsLedger } from "@crewhaus/control-records";

const execution = process.env["CREWHAUS_EXECUTION_ID"];
const run = process.env["MID_TURN_RUN"];
const marker = process.env["MID_TURN_MARKER"];
if (execution === undefined || run === undefined || marker === undefined) {
  throw new Error("CREWHAUS_EXECUTION_ID, MID_TURN_RUN and MID_TURN_MARKER are required");
}
const ledger = runsLedger(process.cwd());
const at = () => new Date().toISOString();
for (const state of ["queued", "preparing", "running"]) {
  const written = append(ledger, {
    id: run,
    state,
    at: at(),
    trigger: { kind: "channel" },
    ...(state === "queued" ? {} : { execution }),
  });
  if (!written.ok) throw new Error(written.reason);
}
writeFileSync(marker, `${process.pid}\n`);
setInterval(() => undefined, 60_000);
