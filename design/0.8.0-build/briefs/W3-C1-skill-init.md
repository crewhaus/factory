# W3-C1 — the `provability` default skill, its registration, and `crewhaus init` (design §11; PR train 10)

You own: `packages/default-skills/**` (a new skill + embedding), the skill registration path
(read below — likely `packages/evaluation-service` and/or `packages/memory-service`, plus each
emitter's skills wiring if needed), and the `init` parts of `apps/cli/src/index.ts` (and any
init/template module it uses: grep `runInit`, `--interactive`, `templates`). Another builder may
edit OTHER regions of apps/cli/src/index.ts at the same time — keep your edits to the init code,
re-read before each edit.

1. **The skill** — `packages/default-skills/skills/provability/SKILL.md` (follow the
   `continuity` / `learning-loop` skills' frontmatter and embedding — read `src/index.ts`,
   `src/embedded.ts` and how bodies are embedded at compile time so compiled binaries never read
   node_modules at runtime; a test probably pins `DEFAULT_SKILL_NAMES` and the embedded set).
   Compile-time substitution of `{{level}}` and `{{checkers}}` (the `renderSkill` precedent).
   Content (design §11): cite with `[n]` and close with a definitions block (`[1]: <url or
   path>`); fetch/read a source before citing it and quote when you can; cite computations as
   `[n]: tool:<toolUseId>` and never restate a number you did not compute; at `proven`, state
   the theorem, pick a checker from `ProofCheckers`, write the certificate, call `ProofCheck`,
   cite `[n]: proof:<id>`; declare assumptions as `[A1]: assume: …`; run `ProvabilityPreflight`
   on the draft before finishing. Explain each rung in one line and say exactly what the gate
   checks at the declared floor (so the model knows what will be verified). Concise — every
   byte is prompt cost on every turn.
2. **Registration** — registered ONLY when the lowered IR carries `provability` (so
   provability-less bundles gain no prompt bytes — prove byte-identical output for a spec
   without the block). Find how the builtin `continuity` skill reaches the skills prompt block
   in compiled bundles AND in `crewhaus run` (wireMemory merges skills when continuity is on);
   the provability skill must reach it whether or not continuity is on — the cleanest seam is
   probably `wireEvaluation` returning `skills` the emitters register the same way, but follow
   what the code actually supports. Children threading is done by another builder.
3. **`crewhaus init --provability <rung>`** — writes `provability: <rung>` into the generated
   spec (validate the rung); and ONE new interactive question in `init --interactive` ("How much
   proof should answers carry?" with off/cited/grounded/checked/proven, one line each); the
   researcher starter template (find the starter templates `init` offers) ships with
   `provability: cited`. Arg-schema registration for the new flag (`apps/cli/src/arg-schemas.ts`)
   and usage text (`apps/cli/src/usage-text.ts`) — those two files are shared with another
   builder working on the `provability` command; re-read before editing, keep edits minimal.

Tests: default-skills (the new skill is embedded, substitutions render, the name list pin
updated deliberately), registration (skill present with the block, absent without — byte
check), init (flag writes the key, invalid rung refused, interactive question appears, the
researcher template carries `provability: cited` and the generated spec parses + compiles).

Verify: `bunx tsc -b` in the packages you touched and apps/cli; `bun test` in default-skills,
the registration package(s), and in apps/cli the init tests (`grep -l "init" apps/cli/src/*.test.ts`
— run the relevant ones, incl. any test that compiles every template); biome.
