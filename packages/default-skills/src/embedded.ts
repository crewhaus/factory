/**
 * Compile-time-embedded bodies of the canonical `skills/<name>/SKILL.md` and
 * `commands/<name>.md` files.
 *
 * The `with { type: "text" }` import attribute makes Bun inline each file's
 * text: on the interpreter path (`bun`/`bunx`) it reads the file from disk at
 * module load, and under `bun build --compile` it bakes the text into the
 * standalone binary's `/$bunfs` image. Either way, no `readFileSync` of a
 * package-relative path runs at runtime.
 *
 * That runtime read is exactly what bricked the compiled `crewhaus` binary:
 * `DEFAULT_SKILLS`/`DEFAULT_COMMANDS` eagerly `readFileSync`'d paths derived
 * from `import.meta.url`, which resolve under `/$bunfs` in a `--compile`
 * binary where the `.md` assets were never present — so every command,
 * including `crewhaus --version`, threw ENOENT at import-graph evaluation.
 *
 * The checked-in `.md` files stay the single source of truth; this module
 * only re-exports their text keyed by name, so there is no second copy to
 * drift. Imports are grouped commands-then-skills to satisfy the import
 * sorter; the `SKILL_BODIES`/`COMMAND_BODIES` maps below fix the semantic
 * ordering.
 */
import clearFocusCommand from "../commands/clear-focus.md" with { type: "text" };
import clearPlanCommand from "../commands/clear-plan.md" with { type: "text" };
import dreamCommand from "../commands/dream.md" with { type: "text" };
import examCommand from "../commands/exam.md" with { type: "text" };
import focusCommand from "../commands/focus.md" with { type: "text" };
import forgetCommand from "../commands/forget.md" with { type: "text" };
import handoffCommand from "../commands/handoff.md" with { type: "text" };
import nextCommand from "../commands/next.md" with { type: "text" };
import planCommand from "../commands/plan.md" with { type: "text" };
import reflectCommand from "../commands/reflect.md" with { type: "text" };
import studyCommand from "../commands/study.md" with { type: "text" };
import continuitySkill from "../skills/continuity/SKILL.md" with { type: "text" };
import dreamSkill from "../skills/dream/SKILL.md" with { type: "text" };
import learningLoopSkill from "../skills/learning-loop/SKILL.md" with { type: "text" };

/** Raw body text of each default skill's `SKILL.md`, keyed by skill name. */
export const SKILL_BODIES: Readonly<Record<string, string>> = {
  continuity: continuitySkill,
  "learning-loop": learningLoopSkill,
  dream: dreamSkill,
};

/** Raw body text of each builtin slash command's `.md`, keyed by command name. */
export const COMMAND_BODIES: Readonly<Record<string, string>> = {
  plan: planCommand,
  focus: focusCommand,
  next: nextCommand,
  handoff: handoffCommand,
  "clear-plan": clearPlanCommand,
  "clear-focus": clearFocusCommand,
  forget: forgetCommand,
  study: studyCommand,
  reflect: reflectCommand,
  exam: examCommand,
  dream: dreamCommand,
};
