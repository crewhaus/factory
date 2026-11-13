import { ABSENT_CORPUS } from "./absent-corpus";

/**
 * The specs that pin `schedule:` (#514). Each is an absent-corpus spec of a
 * shape that carries the block, plus one `schedule:` value.
 * `__fixtures__/delta-090/schedule-object.digests.json` pins what the object
 * form compiles to, so the list form cannot move a byte of a spec that keeps
 * the object form.
 */
const SCHEDULE_SHAPES = ["channel", "managed", "batch"] as const;

const CRON_OBJECT = `schedule:
  kind: cron
  cron: "0 9 * * 1-5"
  timezone: America/New_York
  jitter: 30s
  instructions: Check the overnight queue and summarise it.
`;

const INTERVAL_OBJECT = `schedule:
  kind: interval
  every: 6h
`;

function withEach(block: string, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const shape of SCHEDULE_SHAPES) out[`${shape}-${label}`] = `${ABSENT_CORPUS[shape]}${block}`;
  return out;
}

/** Six specs: channel, managed and batch, each with a cron and an interval object. */
export const SCHEDULE_OBJECT_CORPUS: Readonly<Record<string, string>> = Object.freeze({
  ...withEach(CRON_OBJECT, "cron"),
  ...withEach(INTERVAL_OBJECT, "interval"),
});
