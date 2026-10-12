import { REGEX_RUN_DEFAULTS } from "@crewhaus/tool-safety/regex";

/**
 * Run `body` with the regex worker's give-up threshold out of any runner's
 * reach. The worker reports a failing `exec` that took 100 ms as the engine
 * giving up, never as "no match", so a worker thread a loaded runner stalls
 * that long inside one turns "this TODO has no ticket" into "could not
 * check", and a finding goes undetermined. The call's deadline still stops a
 * pattern that hangs.
 */
export async function withoutGiveUp<T>(body: () => Promise<T>): Promise<T> {
  const defaults = REGEX_RUN_DEFAULTS as { giveUpMs: number };
  const giveUpMs = defaults.giveUpMs;
  defaults.giveUpMs = 60_000;
  try {
    return await body();
  } finally {
    defaults.giveUpMs = giveUpMs;
  }
}
