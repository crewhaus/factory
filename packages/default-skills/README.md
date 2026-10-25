# @crewhaus/default-skills

The skills and slash commands CrewHaus ships by default (v0.3.0 memory
release, design §2.6). Zero SKILL.md files shipped before this package; now
every harness can start with the product's session discipline built in —
and every piece of it is overridable or clearable by the user.

## What ships

**Four skills** (`skills/<name>/SKILL.md`):

| Skill | What it teaches |
| --- | --- |
| `continuity` | The session discipline: read `<current_plan>` first, pin user requirements as verbatim REQ entries, keep the plan current with `PlanUpdate`, claimed-vs-proven status honesty (`PlanComplete` + toolUseId evidence is the only path to proven), bias to action, accurate handoffs. |
| `learning-loop` | The expert demo's four modes, productized: ANSWER (recall first, cite slugs, never bluff, log gaps), STUDY (gaps → curriculum rung → frontier; no source, no commit), REFLECT (stale-first reconcile; supersede, never delete), EXAM (prove it against the configured exam). Templated by `{{domain}}`, `{{curriculum}}`, `{{sources}}`. |
| `dream` | The consolidation playbook consumed by scheduled dream ticks (not user-invoked): merge/split articles, reconcile contradictions, move confidence with evidence, promote corroborated facts to cited drafts, log gaps, refresh next actions — every mutation through the normal audited tools, within budget. |
| `provability` | How to answer under the 0.8.0 proof gate: cite with `[n]` and close with a definitions block, fetch or read a source before citing it and quote it when you can, cite computations as `tool:<toolUseId>` and proofs as `proof:prf_…`, declare assumptions as `[A1]: assume: …`, run `ProvabilityPreflight` on the draft. Says what the gate checks at each rung. Templated from the block's settings that change what the gate accepts (`{{level}}`, `{{checkers}}`, `{{on_fail}}`, `{{window}}`, `{{assumptions}}`, `{{independent}}`) plus a `{{#proofs}}` section kept only where the proof tools are wired; registered only for a spec with a `provability:` block. |

**Eleven builtin slash commands** (`commands/<name>.md`, standard
`$ARGUMENTS` templating): `/plan`, `/focus <text>`, `/next`, `/handoff`,
`/clear-plan`, `/clear-focus`, `/forget <query>`, `/study`, `/reflect`,
`/exam`, `/dream`.

## Dual representation, one source of truth

The checked-in markdown files are canonical. `src/index.ts` parses them
once at import and exports:

- `DEFAULT_SKILLS` (`LoadedSkill[]`, bodies in memory) and the body
  constants `CONTINUITY_SKILL_BODY` / `LEARNING_LOOP_SKILL_BODY` /
  `DREAM_SKILL_BODY` / `PROVABILITY_SKILL_BODY` — for **compile-time
  embedding**: the text is baked into compiled bundles, so a deployed
  bundle never depends on the deploy machine's `node_modules`.
- `builtinSkillsDir` / `builtinCommandsDir` — absolute paths to the same
  files, for **runtime discovery** on the interpreter path.
- `DEFAULT_COMMANDS` (`SlashCommand[]`) and `BUILTIN_COMMAND_NAMES`.

## Wiring

```ts
import { DEFAULT_SKILLS, builtinCommandsDir, renderSkill } from "@crewhaus/default-skills";
import { discoverSkills } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";

// Skills: builtins merge at LOWEST precedence — ~/.crewhaus/skills and
// <cwd>/.crewhaus/skills override by name; an empty-body override
// effectively disables a builtin. DEFAULT_SKILLS bodies are unrendered:
// pass the ones a harness's features use, templated ones rendered first.
const continuity = DEFAULT_SKILLS.filter((s) => s.name === "continuity");
const skills = await discoverSkills({ builtinSkills: continuity });

// Commands: builtin < user (~/.crewhaus/commands) < project (.crewhaus/commands).
const commands = await loadCommands({ builtinDirs: [builtinCommandsDir] });

// Templating carries spec configuration only — tool names are literal (the
// Thredz backend aliases to the same names):
const body = renderSkill("learning-loop", {
  domain: "specialty coffee extraction science",
  curriculum: "curriculum.md",
  sources: "sca.coffee, *.edu",
});
// The provability skill's values come from the lowered block — render it
// through @crewhaus/evaluation-service's provabilitySkills(block).
```

The composition roots register each skill only when its feature is on:
`wireMemory` (`@crewhaus/memory-service`) owns `continuity`, `learning-loop`
and `dream`; `provabilitySkills` (`@crewhaus/evaluation-service`) renders
`provability` from the lowered block, and every surface that discovers skills
passes it as a builtin — so a spec without `provability:` gains no prompt
bytes.

`renderSkill` is strict in both directions: a token in the body without a
substitution throws, and a substitution key absent from the body throws —
wiring bugs surface at compile time, not as literal `{{domain}}` in a
system prompt. A `{{#name}}…{{/name}}` section is kept when its value is
non-empty and dropped whole when it is `""` (a marker alone on its line
takes the line break with it); `skillTokens(body)` lists every name a body
needs, and `renderSkillText(body, …)` applies the same rules to any body.

The builtin `/plan` command reads the plan's statuses as the harness's
`continuity.proof` mode writes them: only `proven` is verified; `claimed`
and `proven (unverified)` (recorded under `proof: off`) are self-reported.

## Trust

Builtins get no trust shortcut. Frontmatter is classified at discovery and
bodies at load, both at the `"skill"` TrustOrigin, exactly like user- or
project-provided skills (Pillar 3). One surface registers a builtin without
discovering: a managed harness with `provability:` and no memory fabric
builds its Skill tool straight over the rendered `provability` skill (that
shape discovers no skills of its own). Nothing reaches the prompt unread
there either — the skill's name and description are this package's shipped
constants (the block substitutes into the body only), and the body is
classified at load like every other. A content-lint test checks every
tool-shaped name in a body's code spans against a pinned vocabulary, and
checks that every tool tool-plan, tool-wiki and tool-proof register is in
it, so a typo or an unpinned tool name fails the test. The `provability`
skill's worked example is parsed by
claim-ledger, the gate's own citation parser, so the example the model is
shown is well formed by the gate's reading: two claims, each with its own
marker, and every marker defined.
