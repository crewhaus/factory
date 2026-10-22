export const meta = {
  name: 'provability-wave-1',
  description: 'Build 0.8.0 wave 1 (claim-ledger, spec/compiler, provability verifiers, proof checkers) with adversarial review and fixes',
  phases: [
    { title: 'Build', detail: 'one builder per component, briefs in the scratchpad' },
    { title: 'Review', detail: 'independent adversarial reviewer per component' },
    { title: 'Fix', detail: 'apply verified review findings' },
  ],
}

const SP = '/ABSOLUTE/PATH/TO/factory/design/0.8.0-build/briefs'
const RULES = `${SP}/RULES.md`

const COMPONENTS = {
  A: { label: 'claim-ledger', brief: 'W1-A-claim-ledger.md', paths: 'packages/claim-ledger packages/tool-verify packages/grader-continuity packages/grader-12-metric-rubric' },
  B: { label: 'spec-compiler', brief: 'W1-B-spec-compiler.md', paths: 'packages/spec packages/compiler apps/cli/src/lint.ts apps/cli/src/lint.test.ts apps/cli/src/model-plan-lint.ts apps/cli/src/model-plan-lint.test.ts' },
  C: { label: 'provability', brief: 'W1-C-provability.md', paths: 'packages/provability apps/cli/src/tool-registry.test.ts' },
  D: { label: 'proof-checker', brief: 'W1-D-proof-checker.md', paths: 'packages/proof-checker packages/sandbox-image-z3 packages/sandbox-image-lean4' },
}

const FINDINGS = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'one paragraph: overall assessment of the implementation against the brief' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string', description: 'file:line, the concrete input and wrong output, or the failing command and its output' },
          fix: { type: 'string', description: 'the specific change that would resolve it' },
        },
        required: ['severity', 'summary', 'evidence', 'fix'],
      },
    },
  },
  required: ['verdict', 'findings'],
}

function buildPrompt(c) {
  return `You are a senior engineer building one component of CrewHaus factory 0.8.0.
First read ${RULES} completely, then your brief at ${SP}/${c.brief}, then the design sections it names in /ABSOLUTE/PATH/TO/factory/design/0.8.0-provability-release.md.
Implement EVERYTHING in the brief, with thorough tests, until typecheck, tests and biome are green for everything you own and everything that imports what you changed.
Work only within your owned paths (${c.paths}) except where the brief or RULES allow otherwise.
Your final message must be the report described at the end of RULES.md.`
}

function reviewPrompt(c, report) {
  return `You are an adversarial code reviewer for CrewHaus factory 0.8.0. Another engineer just implemented the brief at ${SP}/${c.brief} (rules: ${RULES}; design: /ABSOLUTE/PATH/TO/factory/design/0.8.0-provability-release.md).
Their report:
<<<REPORT
${report}
REPORT>>>
Do NOT trust the report. Inspect the actual code: run \`cd /ABSOLUTE/PATH/TO/factory && git status --short\` and \`git diff HEAD -- ${c.paths}\`, read new untracked files under those paths, and read the brief line by line.
Find REAL defects only:
- anything the brief requires that is missing, stubbed, or only half done;
- logic that is wrong for a concrete input (construct the input and run it — write a scratch test under /tmp/provability-review-${c.label}/ or use \`bun -e\`, never inside the repo);
- violations of RULES.md or AGENTS.md pillars (byte-identical absent output, no model calls in provability/claim-ledger/proof-checker, tool flags, path traversal, trust boundaries);
- behaviour changes to existing code that were supposed to be neutral (look for edited assertions in existing test files: \`git diff HEAD -- '*.test.ts'\`);
- tests that do not actually test what they claim (assertions that cannot fail, missing failure cases);
- typecheck/test/biome failures: run \`bunx tsc -b\` and \`bun test\` in each owned package and \`npx biome check\` on the changed files yourself.
Do not edit any file in the repo. Severity: blocker = wrong behaviour, missing required feature, red check, or security hole; major = meaningful gap or weak test coverage of a required behaviour; minor = polish. Every finding needs concrete evidence. If the implementation is sound, return an empty findings array and say so in the verdict.`
}

function fixPrompt(c, review) {
  return `You are finishing one component of CrewHaus factory 0.8.0. Read ${RULES} and the brief at ${SP}/${c.brief}. An adversarial reviewer inspected the current implementation and reported these findings (JSON):
${JSON.stringify(review, null, 2)}
For each finding: verify it against the code. If it is real, fix it properly (with a test that would have caught it). If it is not real, explain why in your report. Fix blockers and majors first; fix minors when cheap and clearly correct.
Stay within the owned paths (${c.paths}) except as RULES.md allows. Re-run typecheck, tests and biome for everything you touched and everything that imports it.
Final message: the RULES.md report format, plus a FINDINGS section listing each finding as FIXED / NOT REAL (why) / DEFERRED (why).`
}

async function runComponent(key) {
  const c = COMPONENTS[key]
  const report = await agent(buildPrompt(c), { label: `build:${c.label}`, phase: 'Build' })
  const review = await agent(reviewPrompt(c, report || '(the builder returned no report)'), { label: `review:${c.label}`, phase: 'Review', schema: FINDINGS })
  const findings = (review && review.findings) || []
  let fixReport = null
  if (findings.length > 0) {
    fixReport = await agent(fixPrompt(c, review), { label: `fix:${c.label}`, phase: 'Fix' })
  }
  log(`${c.label}: ${findings.length} review finding(s) (${findings.filter((f) => f.severity !== 'minor').length} blocking/major)`)
  return { key, label: c.label, report, review, fixReport }
}

const results = await parallel([
  () => runComponent('A').then(async (a) => [a, await runComponent('C')]),
  () => runComponent('B'),
  () => runComponent('D'),
])
return results.flat().filter(Boolean)
