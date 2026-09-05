/**
 * `parseModelDirective` (§7.2.1) — the `/model …` per-message steering
 * token, parsed ONLY at the typed input seams (the REPL input, the last
 * seed message of a single-turn host) and never from the transcript, where
 * runtime-core pushes five kinds of synthetic user messages (grader
 * rationales, continue nudges, tombstones, loop notices, resume markers)
 * that could echo a `/model` string.
 *
 * The target is allow-list validated against the roster: a `$profile`, a
 * bare profile name, a tag, or a candidate's model string. Nothing user-
 * filled can name a model outside the spec — a miss is REFUSED with the
 * roster listed, never resolved by grammar.
 */

/** One roster arm the directive may name. */
export type DirectiveRosterArm = {
  /** The arm identity — profile name when the candidate is a profile, else the model string. */
  readonly armId: string;
  /** The candidate's model string (equal to `armId` for an unprofiled candidate). */
  readonly model?: string;
  readonly tags?: readonly string[];
};

export type ModelDirective =
  | {
      readonly kind: "pin";
      /** The token the user typed after `/model`. */
      readonly requested: string;
      /** The roster arm it resolved to; absent when refused. */
      readonly resolved?: string;
      readonly accepted: boolean;
      readonly reason?: string;
      /** The input with the directive removed (may be empty). */
      readonly rest: string;
    }
  | {
      readonly kind: "clear";
      readonly requested: "auto";
      readonly accepted: true;
      readonly rest: string;
    };

const DIRECTIVE_RE = /^\/model(?:\s+(\S+))?(?:\s+|$)/;

/**
 * Remove a leading `/model <token>` from typed text WITHOUT resolving it
 * against a roster — the REQUEST-copy strip a resumed transcript needs when
 * it replays a `user_message` logged `directive: true` (§7.2.1: the persisted
 * line keeps the token, the request copy never carries it). Returns the text
 * unchanged when it carries no directive; `""` for a directive-only input.
 */
export function stripDirectiveToken(input: string): string {
  const trimmed = input.trimStart();
  const m = trimmed.match(DIRECTIVE_RE);
  if (m === null) return input;
  return trimmed.slice(m[0].length).trim();
}

/**
 * Parse a `/model <target>` or `/model auto` directive at the START of the
 * typed input (leading whitespace tolerated). Returns `undefined` when the
 * input carries no directive — including when `/model` appears anywhere but
 * the start, which is prose, not steering.
 */
export function parseModelDirective(
  input: string,
  roster: readonly DirectiveRosterArm[],
): ModelDirective | undefined {
  const trimmed = input.trimStart();
  const m = trimmed.match(DIRECTIVE_RE);
  if (m === null) return undefined;
  const rest = trimmed.slice(m[0].length).trim();
  const requested = m[1];
  if (requested === undefined) {
    return {
      kind: "pin",
      requested: "",
      accepted: false,
      reason: `"/model" needs a target — one of ${describeRoster(roster)}, or "auto" to clear the pin`,
      rest,
    };
  }
  if (requested === "auto") return { kind: "clear", requested: "auto", accepted: true, rest };
  const resolved = resolveDirectiveTarget(requested, roster);
  if (resolved === undefined) {
    return {
      kind: "pin",
      requested,
      accepted: false,
      reason: `"${requested}" is not in this harness's model roster — one of ${describeRoster(roster)}, or "auto"`,
      rest,
    };
  }
  return { kind: "pin", requested, resolved, accepted: true, rest };
}

/**
 * Resolve a directive target against the roster: `$name` / `name` match an
 * arm id; a tag matches the FIRST arm carrying it (declared order); a model
 * string matches an arm whose model equals it. `undefined` when nothing
 * matches — the caller refuses.
 */
export function resolveDirectiveTarget(
  target: string,
  roster: readonly DirectiveRosterArm[],
): string | undefined {
  const bare = target.startsWith("$") ? target.slice(1) : target;
  const byId = roster.find((a) => a.armId === bare || a.armId === target);
  if (byId !== undefined) return byId.armId;
  const byTag = roster.find((a) => (a.tags ?? []).includes(bare));
  if (byTag !== undefined) return byTag.armId;
  const byModel = roster.find((a) => (a.model ?? a.armId) === target);
  return byModel?.armId;
}

function describeRoster(roster: readonly DirectiveRosterArm[]): string {
  if (roster.length === 0) return "(no roster — this harness declares no model_pool)";
  return roster
    .map((a) => {
      const tags = a.tags !== undefined && a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
      return `"${a.armId}"${tags}`;
    })
    .join(", ");
}
