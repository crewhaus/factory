import { ABSENT_CORPUS } from "./absent-corpus";

/**
 * The specs that pin `plugins:` (#514, #522). Each is an absent-corpus spec of
 * a shape that carries the list (cli and channel), plus one `plugins:` value.
 * `__fixtures__/delta-090/plugins-strings.digests.json` pins what a list of
 * plugin names compiles to, so the `{name, tools}` entry form cannot move a
 * byte of a spec that keeps plain names.
 */
const PLUGINS_SHAPES = ["cli", "channel"] as const;

/** Two names, out of name order, one listed twice: order and repeats are kept as written. */
const NAME_LIST = `plugins:
  - weather-pane
  - notes
  - weather-pane
`;

function withEach(block: string, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const shape of PLUGINS_SHAPES) out[`${shape}-${label}`] = `${ABSENT_CORPUS[shape]}${block}`;
  return out;
}

/** Two specs: cli and channel, each with a list of plugin names. */
export const PLUGINS_STRINGS_CORPUS: Readonly<Record<string, string>> = Object.freeze(
  withEach(NAME_LIST, "strings"),
);

/**
 * A name, then a `{name, tools}` entry whose tools arrive out of order with a
 * repeat: the entry lowers with `tools` sorted and de-duplicated, and the
 * emitted `names:` carries it as JSON beside the name.
 */
const MIXED_LIST = `plugins:
  - notes
  - name: weather-pane
    tools: [Read, Bash, Read]
`;

/** cli and channel, each with the mixed list above. */
export const PLUGINS_GRANTS_CORPUS: Readonly<Record<string, string>> = Object.freeze(
  withEach(MIXED_LIST, "grants"),
);
