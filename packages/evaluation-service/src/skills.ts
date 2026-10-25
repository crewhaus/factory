/**
 * The skill a gated harness advertises (design/0.8.0-provability-release.md
 * §11): `@crewhaus/default-skills`' `provability` skill — what the gate checks
 * at each rung and how to cite so an answer passes — rendered from the lowered
 * block. The `learning-loop` precedent: shipped text, templated from the spec
 * at wiring time.
 *
 * The brief for the text is "say exactly what the gate checks", so every
 * setting that changes what this gate accepts is a substitution
 * ({@link provabilitySkillSubstitutions}), never a sentence that is true
 * only under the defaults: the floor and the checker order, what a failing
 * answer becomes (`on_fail`, `max_retries`), how far back evidence counts
 * (`scope`), whether and how many assumptions are accepted (`assumptions`,
 * `max_assumptions`), how many independent sources a `grounded` claim needs
 * (`grounded.independent`) — and a section kept only where the gate wires
 * `ProofCheckers` + `ProofCheck` (`wantsProofCheckTools`), so the skill never
 * tells the model to call a tool its harness lacks. Settings that only make
 * the gate MORE lenient than the text (a `threshold` below 1, `bibliographic`
 * sources, `replay: false`) are left out: the text then asks for more than
 * the gate needs, never less.
 *
 * Registered ONLY when the IR carries `provability:`, and through the seams
 * every other builtin skill already uses: a surface that discovers its own
 * skills passes `provabilitySkills(block)` as `discoverSkills({ builtinSkills })`,
 * and one whose memory fabric owns the skill surface passes it to
 * `wireMemory(…, { builtinSkills })`. Either way it merges at LOWEST
 * precedence — a user or project skill named `provability` replaces it — and
 * its frontmatter is classified at discovery and its body at load, at the
 * `"skill"` TrustOrigin, like every builtin (Pillar 3). A spec without the
 * block passes nothing: its prompt gains no bytes and its bundle none either
 * (`renderGateSkills` renders the empty string).
 *
 * A pure function of the block rather than a field of `wireEvaluation`'s
 * result, because every surface discovers its skills BEFORE it wires the
 * gates — the cli bundle's extension boot, the channel daemon's boot, the
 * interpreter's run setup — and the skill depends on nothing the wiring
 * builds. The discovery site calls this directly; no boot is reordered.
 *
 * The rendering is the one Task children receive (`./child-skill`'s
 * `provabilitySkillText`, the same substitutions over the same body — a test
 * holds the two together), so a parent and its children are told one thing.
 */
import { DEFAULT_SKILLS, renderSkill, skillTokens } from "@crewhaus/default-skills";
import type { IrProvability } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import type { LoadedSkill } from "@crewhaus/skills-registry";
import { wantsProofCheckTools } from "./tools";

const logger = createLogger({ bindings: { module: "evaluation-service" } });

/** The skill's name — what a user or project skill overrides it by. */
export const PROVABILITY_SKILL_NAME = "provability";

/**
 * The fields of the lowered block the skill is rendered from — everything
 * that changes what the gate accepts at the floor (see the module doc).
 * `IrProvability` is one; a compiled bundle passes exactly these
 * ({@link renderGateSkills}).
 */
export type ProvabilitySkillConfig = Pick<
  IrProvability,
  "level" | "onFail" | "maxRetries" | "scope" | "assumptions" | "maxAssumptions"
> & {
  readonly grounded: Pick<IrProvability["grounded"], "independent">;
  readonly formal: { readonly checkers: ReadonlyArray<string> };
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * What a failing answer becomes — completes "An answer that falls short …".
 *
 * `retry` and `escalate` both re-run the turn and both count against
 * `max_retries` (runtime-core's `runProvableTurn`: a pass at
 * `retryIndex >= maxRetries` is spent and its answer stands with the failing
 * verdict). So the cap belongs in both sentences: at 0 neither re-runs
 * anything — note semantics — and past the cap the last answer, the stronger
 * model's included, is served failing.
 */
function onFailText(config: ProvabilitySkillConfig): string {
  const anyway = "is served anyway, with a failing verdict";
  switch (config.onFail) {
    case "halt":
      return "is never served: the run stops";
    case "note":
      return anyway;
    case "retry":
    case "escalate": {
      // runtime-core's reading of the cap: a non-finite one is 0, and 0 is note.
      const n = Number.isFinite(config.maxRetries) ? Math.max(0, Math.floor(config.maxRetries)) : 0;
      if (n === 0) return anyway;
      const rerun =
        config.onFail === "retry"
          ? "comes back to you with what failed"
          : "goes, with what failed, to a stronger model to answer instead";
      return `${rerun}, at most ${plural(n, "once", `${n} times`)}; after that it is served with a failing verdict`;
    }
  }
}

/** How many assumptions an answer may declare — completes "an assumption: …". */
function assumptionsText(config: ProvabilitySkillConfig): string {
  const cap = config.maxAssumptions;
  if (config.assumptions === "forbid" || cap === 0) {
    return "refused here — declaring one fails the whole answer";
  }
  const keep = "so keep it for what no evidence can settle";
  if (cap === undefined) return `counted and shown to the reader, ${keep}`;
  return `at most ${plural(cap, "one", String(cap))} per answer, each shown to the reader, ${keep}`;
}

/**
 * Every substitution the `provability` skill's body can ask for, computed
 * from `config` — the ONE place the skill's wording meets the block, shared
 * by {@link provabilitySkills} and `./child-skill`'s rendering. A caller
 * passes only the names its body uses (`skillTokens`): the renderer refuses
 * the rest.
 *
 *   - `level` — the floor; `checkers` — `formal.checkers`, comma-separated;
 *   - `on_fail` — what a failing answer becomes;
 *   - `window` — where evidence must come from: `in this session`, or under
 *     `scope: turn` `since the user's last message` (the gate's evidence
 *     index then holds this turn's calls only);
 *   - `assumptions` — accepted and counted, capped, or refused;
 *   - `independent` — at a `grounded` floor with `grounded.independent > 1`,
 *     the clause asking for that many distinct origins; else empty (the rule
 *     applies at no other floor);
 *   - `proofs` — the section holding the proof tools, non-empty exactly when
 *     the gate wires `ProofCheckers` + `ProofCheck` (`wantsProofCheckTools`):
 *     at `proven` every claim needs a proof; below it a proof meets any
 *     floor.
 */
export function provabilitySkillSubstitutions(
  config: ProvabilitySkillConfig,
): Record<string, string> {
  const independent = config.grounded.independent;
  return {
    level: config.level,
    checkers: config.formal.checkers.join(", "),
    on_fail: onFailText(config),
    window: config.scope === "turn" ? "since the user's last message" : "in this session",
    assumptions: assumptionsText(config),
    independent:
      config.level === "grounded" && independent > 1
        ? `; each claim needs ${independent} independent sources (different sites, publishers or files)`
        : "",
    proofs: !wantsProofCheckTools(config)
      ? ""
      : config.level === "proven"
        ? "Every claim needs a proof:"
        : "A proof meets any floor. To prove a claim,",
  };
}

/** {@link provabilitySkillSubstitutions}, narrowed to the names `body` uses. */
export function substitutionsFor(
  config: ProvabilitySkillConfig,
  body: string,
): Record<string, string> {
  const used = skillTokens(body);
  return Object.fromEntries(
    Object.entries(provabilitySkillSubstitutions(config)).filter(([token]) => used.has(token)),
  );
}

/** Where the skill comes from (default: the shipped default skills); a seam for tests. */
export type ProvabilitySkillSource = {
  readonly skills: ReadonlyArray<LoadedSkill>;
  readonly render: (name: string, substitutions: Record<string, string>) => string;
};

const DEFAULT_SOURCE: ProvabilitySkillSource = { skills: DEFAULT_SKILLS, render: renderSkill };

/**
 * The gate's builtin skills for `config` — the rendered `provability` skill,
 * or `[]` when there is no block (so a call site may pass the IR's optional
 * block unconditionally). Also `[]`, with a warning, when this build ships no
 * such skill or its body asks for a substitution the block cannot fill: a
 * missing skill is a wiring gap the gate's retry nudge still covers, never a
 * reason to fail a harness at boot.
 */
export function provabilitySkills(
  config: ProvabilitySkillConfig | undefined,
  source: ProvabilitySkillSource = DEFAULT_SOURCE,
): ReadonlyArray<LoadedSkill> {
  if (config === undefined) return [];
  const skill = source.skills.find((s) => s.name === PROVABILITY_SKILL_NAME);
  if (skill === undefined) {
    logger.warn("provability: this build ships no provability skill; none is registered");
    return [];
  }
  try {
    // Only the names the body uses: the renderer refuses a key the body lacks.
    // Computed inside the try: a block missing a field (a bundle compiled
    // against another shape) costs the skill, never the boot.
    const substitutions = substitutionsFor(config, skill.body);
    return [{ ...skill, body: source.render(PROVABILITY_SKILL_NAME, substitutions) }];
  } catch (err) {
    logger.warn("provability: the provability skill could not be rendered; none is registered", {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** The codegen twin of {@link provabilitySkills} (see {@link renderGateSkills}). */
export type GateSkillsWiring = {
  /** `import { provabilitySkills } from "@crewhaus/evaluation-service";`, or none. */
  readonly imports: readonly string[];
  /**
   * The expression for the gate's builtin skills — `provabilitySkills({…})`
   * over the fields it reads — or `""` when the IR declares no
   * `provability:`.
   */
  readonly expr: string;
};

const NO_GATE_SKILLS: GateSkillsWiring = { imports: [], expr: "" };

/**
 * What an emitter splices into a skill-discovery site (design §11): the
 * import and the `provabilitySkills(…)` expression, rendered from the lowered
 * block. The emitter passes it as `builtinSkills` to the `discoverSkills` /
 * `wireMemory` call that builds the run's skill list — the
 * `renderEvaluationWiring` / `renderMemory` precedent: one rendering, owned
 * by the composition root, so no emitter templates the skill itself. Both
 * pieces empty without `provability:`, keeping those bundles byte-identical.
 *
 * The argument is `JSON.stringify` of the {@link ProvabilitySkillConfig}
 * fields, in a fixed order: plain data (rung and mode names, counts, checker
 * ids), so JSON's quoting is the escaping, and only what the skill reads
 * rides along — the full block is already in the bundle's `wireEvaluation`
 * fragment.
 */
export function renderGateSkills(ir: {
  readonly provability?: IrProvability;
}): GateSkillsWiring {
  const p = ir.provability;
  if (p === undefined) return NO_GATE_SKILLS;
  const arg: ProvabilitySkillConfig = {
    level: p.level,
    onFail: p.onFail,
    maxRetries: p.maxRetries,
    scope: p.scope,
    assumptions: p.assumptions,
    ...(p.maxAssumptions !== undefined ? { maxAssumptions: p.maxAssumptions } : {}),
    grounded: { independent: p.grounded.independent },
    formal: { checkers: [...p.formal.checkers] },
  };
  return {
    imports: ['import { provabilitySkills } from "@crewhaus/evaluation-service";'],
    expr: `provabilitySkills(${JSON.stringify(arg)})`,
  };
}
