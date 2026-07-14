# @crewhaus/default-skills

The skills and slash commands CrewHaus ships by default (v0.3.0 memory
release, design §2.6). Zero SKILL.md files shipped before this package; now
every harness can start with the product's session discipline built in —
and every piece of it is overridable or clearable by the user.

## What ships

**Three skills** (`skills/<name>/SKILL.md`):

| Skill | What it teaches |
| --- | --- |
| `continuity` | The session discipline: read `<current_plan>` first, pin user requirements as verbatim REQ entries, keep the plan current with `PlanUpdate`, claimed-vs-proven status honesty (`PlanComplete` + toolUseId evidence is the only path to proven), bias to action, accurate handoffs. |
| `learning-loop` | The expert demo's four modes, productized: ANSWER (recall first, cite slugs, never bluff, log gaps), STUDY (gaps → curriculum rung → frontier; no source, no commit), REFLECT (stale-first reconcile; supersede, never delete), EXAM (prove it against the configured exam). Templated by `{{domain}}`, `{{curriculum}}`, `{{sources}}`. |
| `dream` | The consolidation playbook consumed by scheduled dream ticks (not user-invoked): merge/split articles, reconcile contradictions, move confidence with evidence, promote corroborated facts to cited drafts, log gaps, refresh next actions — every mutation through the normal audited tools, within budget. |

**Eleven builtin slash commands** (`commands/<name>.md`, standard
`$ARGUMENTS` templating): `/plan`, `/focus <text>`, `/next`, `/handoff`,
`/clear-plan`, `/clear-focus`, `/forget <query>`, `/study`, `/reflect`,
`/exam`, `/dream`.

## Dual representation, one source of truth

The checked-in markdown files are canonical. `src/index.ts` parses them
once at import and exports:

- `DEFAULT_SKILLS` (`LoadedSkill[]`, bodies in memory) and the body
  constants `CONTINUITY_SKILL_BODY` / `LEARNING_LOOP_SKILL_BODY` /
  `DREAM_SKILL_BODY` — for **compile-time embedding**: target emitters
  inline the text into generated bundles, so a deployed bundle never
  depends on the deploy machine's `node_modules`.
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
// effectively disables a builtin.
const skills = await discoverSkills({ builtinSkills: DEFAULT_SKILLS });

// Commands: builtin < user (~/.crewhaus/commands) < project (.crewhaus/commands).
const commands = await loadCommands({ builtinDirs: [builtinCommandsDir] });

// Learning-domain templating (the ONLY use of {{tokens}} — tool names are
// literal; the Thredz backend aliases to the same names):
const body = renderSkill("learning-loop", {
  domain: "specialty coffee extraction science",
  curriculum: "curriculum.md",
  sources: "sca.coffee, *.edu",
});
```

`renderSkill` is strict in both directions: a token in the body without a
substitution throws, and a substitution key absent from the body throws —
wiring bugs surface at compile time, not as literal `{{domain}}` in a
system prompt.

## Trust

Builtins get no trust shortcut. Frontmatter is classified at discovery and
bodies at load, both at the `"skill"` TrustOrigin, exactly like user- or
project-provided skills (Pillar 3). A content-lint test pins every tool
name mentioned in the bodies to the real v0.3.0 tool vocabulary so the
prose cannot drift from the tools.

Emitter and interpreter wiring lands in later PRs of the v0.3.0 train.
