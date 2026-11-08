/**
 * release.yml's release-candidate and dry-run modes, held two ways.
 *
 *   - `releaseWorkflowProblems` reads the parsed workflow and names what is
 *     missing: a release candidate reaches npm only under `next` and never the
 *     package managers or main's digest record; a dry run publishes nothing; the
 *     macOS and Windows binaries are run before Homebrew, Scoop and winget
 *     publish; the version comes from scripts/release-version.ts; every `${{ }}`
 *     reaches a shell through `env:`. Over the real file it returns nothing, and
 *     each planted mutation of a copy returns its own named problem.
 *   - The new shell is run for real under the runner's bash with the outside
 *     world stubbed on PATH: the GitHub release step (`gh`), the npm step
 *     (`bun`), the binary's `--version` check, and the digest commit's retry,
 *     against a local bare repository that gains a competing digest commit while
 *     the job runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);
const WORKFLOW_FILE = join(ROOT, ".github", "workflows", "release.yml");

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { include?: Record<string, string>[] } };
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } };
  jobs: Record<string, Job>;
};

const load = (): Workflow => Bun.YAML.parse(readFileSync(WORKFLOW_FILE, "utf8")) as Workflow;

const PRERELEASE_OFF = "needs.build.outputs.prerelease != 'true'";
const DRY_RUN_OFF = "needs.build.outputs.dry_run != 'true'";
const PACKAGE_MANAGERS = ["homebrew", "scoop", "apt", "winget"] as const;
const SMOKED_FIRST = ["homebrew", "scoop", "winget"] as const;

const needsOf = (job: Job | undefined): string[] =>
  job?.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
const stepNamed = (job: Job | undefined, name: string): Step | undefined =>
  job?.steps?.find((s) => s.name === name);
const stepRunning = (job: Job | undefined, text: string): Step | undefined =>
  job?.steps?.find((s) => s.run?.includes(text));

/** The body of the step's first `for attempt …; do` loop, up to its `done`. */
function retryLoop(run: string): string | undefined {
  const lines = run.split("\n");
  const start = lines.findIndex((l) => /^\s*for attempt in /.test(l));
  if (start < 0) return undefined;
  const indent = (lines[start] as string).match(/^\s*/)?.[0] ?? "";
  const end = lines.findIndex((l, i) => i > start && l === `${indent}done`);
  return end < 0 ? undefined : lines.slice(start + 1, end).join("\n");
}

/** Everything that keeps release.yml from holding the release-candidate and dry-run rules. */
function releaseWorkflowProblems(wf: Workflow): string[] {
  const problems: string[] = [];
  const jobs = wf.jobs ?? {};

  // The dispatch input.
  const dry = wf.on?.workflow_dispatch?.inputs?.["dry_run"];
  if (dry === undefined) problems.push("dispatch: there is no dry_run input");
  else {
    if (dry.type !== "boolean") problems.push("dispatch: the dry_run input is not a boolean");
    if (dry.default !== false)
      problems.push("dispatch: the dry_run input does not default to false");
  }

  // build: one module decides the mode.
  const build = jobs["build"];
  for (const output of ["prerelease", "dry_run"]) {
    if (build?.outputs?.[output] !== `\${{ steps.version.outputs.${output} }}`) {
      problems.push(`build: it has no ${output} output from the version step`);
    }
  }
  const resolve = build?.steps?.find((s) => s.id === "version");
  if (!resolve?.run?.includes("bun scripts/release-version.ts")) {
    problems.push("build: the version step does not call scripts/release-version.ts");
  }
  if (
    resolve?.env?.["INPUT_DRY_RUN"] !== "${{ inputs.dry_run }}" ||
    !resolve.run?.includes('--dry-run "$INPUT_DRY_RUN"')
  ) {
    problems.push("build: the version step does not pass the dry_run input through env");
  }

  // The GitHub release: a pre-release for a candidate, a draft for a dry run.
  const release = stepNamed(build, "Create GitHub Release with binaries");
  const rel = release?.run ?? "";
  if (!rel.includes('if [ "$PRERELEASE" = "true" ]; then KIND+=(--prerelease); fi')) {
    problems.push("release: --prerelease is not added for a release candidate");
  }
  if (!/gh release create[\s\S]*?"\$\{KIND\[@\]\}"[\s\S]*?\|\| gh release upload/.test(rel)) {
    problems.push("release: the real create does not carry the release kind");
  }
  if (!rel.includes('if [ "$DRY_RUN" = "true" ]; then') || !rel.includes('--draft "${KIND[@]}"')) {
    problems.push("release: a dry run does not create a draft");
  }
  if (!rel.includes("already a published release; a dry run never touches one")) {
    problems.push("release: a dry run does not refuse a published release");
  }
  if (!rel.includes('gh release edit "v$VERSION" --repo "$REPO" --draft=false "${KIND[@]}"')) {
    problems.push(
      "release: a real run does not publish a draft it finds (gh release edit … --draft=false)",
    );
  }
  if (release?.env?.["PRERELEASE"] !== "${{ steps.version.outputs.prerelease }}") {
    problems.push("release: PRERELEASE does not come from the version step");
  }
  if (release?.env?.["DRY_RUN"] !== "${{ steps.version.outputs.dry_run }}") {
    problems.push("release: DRY_RUN does not come from the version step");
  }
  const upload = build?.steps?.find(
    (s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.["name"] === "binaries",
  );
  if (upload?.with?.["path"] !== "dist/crewhaus-*") {
    problems.push("build: it does not upload dist/crewhaus-* as the binaries artifact");
  }

  // binary-smoke.
  const smoke = jobs["binary-smoke"];
  if (smoke === undefined) problems.push("binary-smoke: the job is missing");
  else {
    if (!needsOf(smoke).includes("build")) problems.push("binary-smoke: it does not need build");
    const minutes = smoke["timeout-minutes"];
    if (typeof minutes !== "number" || minutes <= 0 || minutes > 20) {
      problems.push("binary-smoke: it has no timeout of 20 minutes or less");
    }
    if (smoke.strategy?.["fail-fast"] !== false)
      problems.push("binary-smoke: fail-fast is not off");
    const oses = (smoke.strategy?.matrix?.include ?? []).map((m) => m["os"]);
    for (const os of ["macos-14", "windows-latest"]) {
      if (!oses.includes(os)) problems.push(`binary-smoke: its matrix lacks ${os}`);
    }
    if (!stepRunning(smoke, "--version")) problems.push("binary-smoke: no step runs --version");
    if (!stepRunning(smoke, "hangar serve --smoke"))
      problems.push("binary-smoke: no step runs hangar serve --smoke");
    if (smoke.steps?.some((s) => s.uses?.startsWith("oven-sh/setup-bun@"))) {
      problems.push("binary-smoke: it installs Bun, which the binaries embed");
    }
    const download = smoke.steps?.find((s) => s.uses?.startsWith("actions/download-artifact@"));
    if (download?.with?.["name"] !== "binaries") {
      problems.push("binary-smoke: it does not run the build's binaries artifact");
    }
  }

  // The channels.
  for (const name of [...PACKAGE_MANAGERS, "docker-digests"]) {
    const cond = jobs[name]?.if ?? "";
    if (!cond.includes(PRERELEASE_OFF)) problems.push(`${name}: it runs for a release candidate`);
    if (!cond.includes(DRY_RUN_OFF)) problems.push(`${name}: it runs on a dry run`);
    if (
      cond.includes(PRERELEASE_OFF) &&
      cond.includes(DRY_RUN_OFF) &&
      cond !== `${PRERELEASE_OFF} && ${DRY_RUN_OFF}`
    ) {
      problems.push(`${name}: its condition is not exactly "${PRERELEASE_OFF} && ${DRY_RUN_OFF}"`);
    }
  }
  for (const name of ["docker", "sandbox-images"]) {
    if (jobs[name]?.if !== DRY_RUN_OFF) problems.push(`${name}: it runs on a dry run`);
  }
  for (const name of SMOKED_FIRST) {
    if (!needsOf(jobs[name]).includes("binary-smoke")) {
      problems.push(`${name}: it publishes without waiting on binary-smoke`);
    }
  }

  // npm: always runs; the dist tag and the dry run come from build's outputs.
  const npm = jobs["npm"];
  if (npm?.if !== undefined)
    problems.push("npm: it has a condition, so some release would skip npm");
  if (npm?.permissions?.["id-token"] !== "write") problems.push("npm: it lacks id-token: write");
  const publish = stepRunning(npm, "scripts/publish-workspace.ts");
  const pub = publish?.run ?? "";
  if (!pub.includes('if [ "$PRERELEASE" = "true" ]; then ARGS+=(--dist-tag next); fi')) {
    problems.push("npm: a release candidate is not published with --dist-tag next");
  }
  if (!pub.includes('if [ "$DRY_RUN" = "true" ]; then ARGS+=(--dry-run); fi')) {
    problems.push("npm: a dry run is not published with --dry-run");
  }
  if (!pub.includes('bun scripts/publish-workspace.ts "${ARGS[@]}"')) {
    problems.push("npm: the publish does not take the arguments it built");
  }
  if (publish?.env?.["PRERELEASE"] !== "${{ needs.build.outputs.prerelease }}") {
    problems.push("npm: PRERELEASE does not come from needs.build.outputs.prerelease");
  }
  if (publish?.env?.["DRY_RUN"] !== "${{ needs.build.outputs.dry_run }}") {
    problems.push("npm: DRY_RUN does not come from needs.build.outputs.dry_run");
  }

  // docker-digests: re-record on a fresh main between attempts, never rebase.
  const commit = stepNamed(jobs["docker-digests"], "Commit digests.json back to main");
  const body = commit?.run ?? "";
  if (body.includes("git pull --rebase"))
    problems.push("docker-digests: the commit step rebases with git pull --rebase");
  const loop = retryLoop(body) ?? "";
  if (!loop.includes("git reset --hard origin/main")) {
    problems.push("docker-digests: the retry loop does not start again from origin/main");
  }
  if (
    !loop.includes('bun scripts/record-image-digests.ts --version "$VERSION" --targets "$TARGETS"')
  ) {
    problems.push("docker-digests: the retry loop does not re-record the digests");
  }
  if (commit?.env?.["TARGETS_JSON"] !== "${{ needs.docker-targets.outputs.targets }}") {
    problems.push("docker-digests: the commit step does not read the docker job's targets");
  }

  // The header's rule, over every job.
  for (const [name, job] of Object.entries(jobs)) {
    for (const s of job.steps ?? []) {
      if (s.run?.includes("${{"))
        problems.push(`${name}: a run: block inlines \${{ }} (${s.name ?? "unnamed step"})`);
    }
  }
  return problems;
}

describe("releaseWorkflowProblems", () => {
  test("the workflow is still named release.yml, the name every trusted publisher is bound to", () => {
    expect(existsSync(WORKFLOW_FILE)).toBe(true);
    expect(
      readFileSync(join(ROOT, "scripts", "configure-trusted-publishers.ts"), "utf8"),
    ).toContain('const WORKFLOW_FILE = "release.yml";');
  });

  test("the real file has none", () => {
    expect(releaseWorkflowProblems(load())).toEqual([]);
  });

  type Mutation = readonly [string, (wf: Workflow) => void, string];
  const job = (wf: Workflow, name: string): Job => wf.jobs[name] as Job;
  const step = (wf: Workflow, jobName: string, pick: (s: Step) => boolean): Step =>
    job(wf, jobName).steps?.find(pick) as Step;
  const edit = (s: Step, from: string, to: string) => {
    expect(s.run).toContain(from);
    s.run = (s.run ?? "").replace(from, to);
  };
  const releaseStep = (wf: Workflow) =>
    step(wf, "build", (s) => s.name === "Create GitHub Release with binaries");
  const npmStep = (wf: Workflow) =>
    step(wf, "npm", (s) => s.run?.includes("publish-workspace") === true);
  const commitStep = (wf: Workflow) =>
    step(wf, "docker-digests", (s) => s.name === "Commit digests.json back to main");

  const MUTATIONS: readonly Mutation[] = [
    ...PACKAGE_MANAGERS.flatMap((name): Mutation[] => [
      [
        `${name} without the prerelease condition`,
        (wf) => {
          job(wf, name).if = DRY_RUN_OFF;
        },
        `${name}: it runs for a release candidate`,
      ],
      [
        `${name} without the dry-run condition`,
        (wf) => {
          job(wf, name).if = PRERELEASE_OFF;
        },
        `${name}: it runs on a dry run`,
      ],
    ]),
    [
      "docker-digests without the prerelease condition",
      (wf) => {
        job(wf, "docker-digests").if = DRY_RUN_OFF;
      },
      "docker-digests: it runs for a release candidate",
    ],
    [
      "docker-digests without the dry-run condition",
      (wf) => {
        Reflect.deleteProperty(job(wf, "docker-digests"), "if");
      },
      "docker-digests: it runs on a dry run",
    ],
    [
      "homebrew with an || between its conditions",
      (wf) => {
        job(wf, "homebrew").if = `${PRERELEASE_OFF} || ${DRY_RUN_OFF}`;
      },
      "homebrew: its condition is not exactly",
    ],
    [
      "docker without the dry-run condition",
      (wf) => {
        Reflect.deleteProperty(job(wf, "docker"), "if");
      },
      "docker: it runs on a dry run",
    ],
    [
      "sandbox-images without the dry-run condition",
      (wf) => {
        Reflect.deleteProperty(job(wf, "sandbox-images"), "if");
      },
      "sandbox-images: it runs on a dry run",
    ],
    ...SMOKED_FIRST.map(
      (name): Mutation => [
        `${name} not waiting on binary-smoke`,
        (wf) => {
          job(wf, name).needs = "build";
        },
        `${name}: it publishes without waiting on binary-smoke`,
      ],
    ),
    [
      "binary-smoke removed",
      (wf) => {
        Reflect.deleteProperty(wf.jobs, "binary-smoke");
      },
      "binary-smoke: the job is missing",
    ],
    ...["macos-14", "windows-latest"].map(
      (os): Mutation => [
        `a binary-smoke matrix without ${os}`,
        (wf) => {
          const m = job(wf, "binary-smoke").strategy?.matrix;
          if (m) m.include = (m.include ?? []).filter((e) => e["os"] !== os);
        },
        `binary-smoke: its matrix lacks ${os}`,
      ],
    ),
    [
      "a binary-smoke without --version",
      (wf) => {
        job(wf, "binary-smoke").steps = job(wf, "binary-smoke").steps?.filter(
          (s) => !s.run?.includes("--version"),
        );
      },
      "binary-smoke: no step runs --version",
    ],
    [
      "a binary-smoke without hangar serve --smoke",
      (wf) => {
        job(wf, "binary-smoke").steps = job(wf, "binary-smoke").steps?.filter(
          (s) => !s.run?.includes("hangar serve --smoke"),
        );
      },
      "binary-smoke: no step runs hangar serve --smoke",
    ],
    [
      "a binary-smoke that installs Bun",
      (wf) => {
        job(wf, "binary-smoke").steps?.unshift({
          uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
        });
      },
      "binary-smoke: it installs Bun",
    ],
    [
      "a binary-smoke with a long timeout",
      (wf) => {
        job(wf, "binary-smoke")["timeout-minutes"] = 60;
      },
      "binary-smoke: it has no timeout of 20 minutes or less",
    ],
    [
      "npm without --dist-tag next",
      (wf) => edit(npmStep(wf), "ARGS+=(--dist-tag next)", "true"),
      "npm: a release candidate is not published with --dist-tag next",
    ],
    [
      "npm without --dry-run",
      (wf) => edit(npmStep(wf), "ARGS+=(--dry-run)", "true"),
      "npm: a dry run is not published with --dry-run",
    ],
    [
      "npm taking the dist tag from the dispatch input",
      (wf) => {
        (npmStep(wf).env as Record<string, string>)["PRERELEASE"] = "${{ inputs.prerelease }}";
      },
      "npm: PRERELEASE does not come from needs.build.outputs.prerelease",
    ],
    [
      "npm taking the dry run from the dispatch input",
      (wf) => {
        (npmStep(wf).env as Record<string, string>)["DRY_RUN"] = "${{ inputs.dry_run }}";
      },
      "npm: DRY_RUN does not come from needs.build.outputs.dry_run",
    ],
    [
      "npm without id-token: write",
      (wf) => {
        Reflect.deleteProperty(job(wf, "npm").permissions as Record<string, string>, "id-token");
      },
      "npm: it lacks id-token: write",
    ],
    [
      "npm skipped for some releases",
      (wf) => {
        job(wf, "npm").if = PRERELEASE_OFF;
      },
      "npm: it has a condition",
    ],
    [
      "the release without a conditional --prerelease",
      (wf) => edit(releaseStep(wf), "KIND+=(--prerelease)", "true"),
      "release: --prerelease is not added for a release candidate",
    ],
    [
      "the release without --draft for a dry run",
      (wf) => edit(releaseStep(wf), '--draft "${KIND[@]}"', '"${KIND[@]}"'),
      "release: a dry run does not create a draft",
    ],
    [
      "the release without publishing a draft it finds",
      (wf) => edit(releaseStep(wf), "--draft=false", ""),
      "release: a real run does not publish a draft it finds",
    ],
    [
      "a dry run that would touch a published release",
      (wf) =>
        edit(releaseStep(wf), "already a published release; a dry run never touches one", "x"),
      "release: a dry run does not refuse a published release",
    ],
    [
      "the digest commit rebasing",
      (wf) => edit(commitStep(wf), "git reset --hard origin/main", "git pull --rebase origin main"),
      "docker-digests: the commit step rebases with git pull --rebase",
    ],
    [
      "the digest retry without a fresh main",
      (wf) => edit(commitStep(wf), "git reset --hard origin/main", "true"),
      "docker-digests: the retry loop does not start again from origin/main",
    ],
    [
      "the digest retry without the re-record",
      (wf) =>
        edit(
          commitStep(wf),
          'bun scripts/record-image-digests.ts --version "$VERSION" --targets "$TARGETS"',
          "true",
        ),
      "docker-digests: the retry loop does not re-record the digests",
    ],
    [
      "the digest commit without the docker job's targets",
      (wf) => {
        Reflect.deleteProperty(commitStep(wf).env as Record<string, string>, "TARGETS_JSON");
      },
      "docker-digests: the commit step does not read the docker job's targets",
    ],
    [
      "no dry_run input",
      (wf) => {
        Reflect.deleteProperty(wf.on?.workflow_dispatch?.inputs ?? {}, "dry_run");
      },
      "dispatch: there is no dry_run input",
    ],
    [
      "a dry_run input that is a string",
      (wf) => {
        (wf.on?.workflow_dispatch?.inputs?.["dry_run"] as { type?: string }).type = "string";
      },
      "dispatch: the dry_run input is not a boolean",
    ],
    [
      "a dry_run input that defaults to true",
      (wf) => {
        (wf.on?.workflow_dispatch?.inputs?.["dry_run"] as { default?: unknown }).default = true;
      },
      "dispatch: the dry_run input does not default to false",
    ],
    [
      "build without the prerelease output",
      (wf) => {
        Reflect.deleteProperty(job(wf, "build").outputs ?? {}, "prerelease");
      },
      "build: it has no prerelease output from the version step",
    ],
    [
      "build without the dry_run output",
      (wf) => {
        Reflect.deleteProperty(job(wf, "build").outputs ?? {}, "dry_run");
      },
      "build: it has no dry_run output from the version step",
    ],
    [
      "build's version step back on a shell regex",
      (wf) =>
        edit(
          step(wf, "build", (s) => s.id === "version"),
          "bun scripts/release-version.ts",
          "grep -Eq '^[0-9]+'",
        ),
      "build: the version step does not call scripts/release-version.ts",
    ],
    [
      "build without the binaries artifact",
      (wf) => {
        job(wf, "build").steps = job(wf, "build").steps?.filter(
          (s) => s.with?.["name"] !== "binaries",
        );
      },
      "build: it does not upload dist/crewhaus-* as the binaries artifact",
    ],
    [
      "a ${{ }} inlined into a run: block",
      (wf) => edit(npmStep(wf), "ARGS=()", "ARGS=(${{ inputs.flags }})"),
      "npm: a run: block inlines ${{ }}",
    ],
  ];

  test.each(MUTATIONS.map((m) => [m[0], m] as const))(
    "planted: %s",
    (_label, [, mutate, expected]) => {
      const wf = structuredClone(load());
      mutate(wf);
      const problems = releaseWorkflowProblems(wf);
      expect(problems.some((p) => p.includes(expected))).toBe(true);
    },
  );

  test("the mutations above cover every rule the checker has", () => {
    // Each distinct problem the checker can report is planted at least once.
    const reported = new Set<string>();
    for (const [, mutate] of MUTATIONS) {
      const wf = structuredClone(load());
      mutate(wf);
      for (const p of releaseWorkflowProblems(wf)) reported.add(p);
    }
    expect(reported.size).toBeGreaterThanOrEqual(MUTATIONS.length - 2);
  });
});

// ─── the shell, run for real ──────────────────────────────────────────────────

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const writeExec = (path: string, text: string): void => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

type Run = { exitCode: number; stdout: string; stderr: string };

/** A step's `run:` under the runner's bash (`bash -e`, or `-eo pipefail` for `shell: bash`). */
function runStep(
  script: string,
  opts: { cwd: string; env: Record<string, string>; pipefail?: boolean },
): Run {
  const file = join(tempDir("release-rc-step-"), "step.sh");
  writeFileSync(file, script);
  const flags = opts.pipefail ? ["-eo", "pipefail"] : ["-e"];
  const r = Bun.spawnSync(["bash", "--noprofile", "--norc", ...flags, file], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const lines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

describe("the GitHub release step, with gh stubbed", () => {
  const RUN = stepNamed(load().jobs["build"], "Create GitHub Release with binaries")?.run ?? "";
  // `release view … --jq .isDraft` prints the state, or fails for no release;
  // a create over an existing release fails, as gh's does.
  const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "release view")
    if [ "$FAKE_STATE" = absent ]; then echo "release not found" >&2; exit 1; fi
    echo "$FAKE_STATE" ;;
  "release create")
    if [ "$FAKE_STATE" != absent ]; then echo "a release with the same tag name already exists" >&2; exit 1; fi ;;
  "release upload"|"release edit") ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;

  function release(state: "absent" | "true" | "false", prerelease: boolean, dryRun: boolean) {
    const dir = tempDir("release-rc-gh-");
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "crewhaus-linux-x64-0.9.0"), "bin");
    writeExec(join(dir, "bin", "gh"), FAKE_GH);
    const log = join(dir, "gh.log");
    const r = runStep(RUN, {
      cwd: dir,
      env: {
        PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
        FAKE_GH_LOG: log,
        FAKE_STATE: state,
        VERSION: "0.9.0",
        PRERELEASE: String(prerelease),
        DRY_RUN: String(dryRun),
        REPO: "crewhaus/factory",
      },
    });
    const calls = lines(log).filter((c) => !c.startsWith("release view"));
    return { ...r, calls };
  }
  const ASSET = "dist/crewhaus-linux-x64-0.9.0";
  const CREATE =
    "release create v0.9.0 --repo crewhaus/factory --title crewhaus v0.9.0 --generate-notes";

  test("a dry run with no release creates a draft, a pre-release for a candidate", () => {
    expect(release("absent", true, true).calls).toEqual([
      `${CREATE} --draft --prerelease ${ASSET}`,
    ]);
    expect(release("absent", false, true).calls).toEqual([`${CREATE} --draft ${ASSET}`]);
  });

  test("a dry run over its own earlier draft refreshes the draft's assets only", () => {
    const r = release("true", true, true);
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([`release upload v0.9.0 --repo crewhaus/factory --clobber ${ASSET}`]);
  });

  test("a dry run never touches a published release", () => {
    const r = release("false", false, true);
    expect(r.exitCode).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain(
      "::error::v0.9.0 is already a published release; a dry run never touches one. Nothing was changed.",
    );
  });

  test("a real run creates the release, a pre-release for a candidate, never a draft", () => {
    expect(release("absent", true, false).calls).toEqual([`${CREATE} --prerelease ${ASSET}`]);
    expect(release("absent", false, false).calls).toEqual([`${CREATE} ${ASSET}`]);
  });

  test("a real run that finds a draft of its version uploads, then publishes it", () => {
    expect(release("true", true, false).calls).toEqual([
      `release upload v0.9.0 --repo crewhaus/factory --clobber ${ASSET}`,
      "release edit v0.9.0 --repo crewhaus/factory --draft=false --prerelease",
    ]);
    expect(release("true", false, false).calls).toEqual([
      `release upload v0.9.0 --repo crewhaus/factory --clobber ${ASSET}`,
      "release edit v0.9.0 --repo crewhaus/factory --draft=false",
    ]);
  });

  test("a real re-run over a published release re-uploads, as before", () => {
    const r = release("false", false, false);
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      `${CREATE} ${ASSET}`,
      `release upload v0.9.0 --repo crewhaus/factory --clobber ${ASSET}`,
    ]);
  });
});

describe("the npm step, with bun stubbed", () => {
  const RUN = stepRunning(load().jobs["npm"], "scripts/publish-workspace.ts")?.run ?? "";

  test.each([
    [false, false, "scripts/publish-workspace.ts"],
    [true, false, "scripts/publish-workspace.ts --dry-run"],
    [false, true, "scripts/publish-workspace.ts --dist-tag next"],
    [true, true, "scripts/publish-workspace.ts --dry-run --dist-tag next"],
  ])("dry run %p, release candidate %p: bun %s", (dryRun, prerelease, argv) => {
    const dir = tempDir("release-rc-npm-");
    mkdirSync(join(dir, "bin"));
    writeExec(join(dir, "bin", "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_BUN_LOG"\n`);
    const log = join(dir, "bun.log");
    const r = runStep(RUN, {
      cwd: dir,
      env: {
        PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
        HOME: dir,
        FAKE_BUN_LOG: log,
        NPM_TOKEN: "",
        PRERELEASE: String(prerelease),
        DRY_RUN: String(dryRun),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(lines(log)).toEqual([argv]);
  });
});

describe("binary-smoke's --version check", () => {
  const RUN = stepRunning(load().jobs["binary-smoke"], "--version")?.run ?? "";

  function check(prints: string) {
    const dir = tempDir("release-rc-version-");
    const bin = join(dir, "crewhaus");
    writeExec(bin, `#!/bin/sh\nprintf '%s' "$FAKE_PRINTS"\n`);
    return runStep(RUN, {
      cwd: dir,
      pipefail: true,
      env: {
        PATH: process.env["PATH"] ?? "",
        BIN: bin,
        VERSION: "0.9.0-rc.1",
        RUNNER_OS: "Windows",
        FAKE_PRINTS: prints,
      },
    });
  }

  test("a Windows line ending is not a mismatch", () => {
    const r = check("0.9.0-rc.1\r\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("binary smoke OK: 0.9.0-rc.1");
  });

  test("another version fails, saying what it printed", () => {
    const r = check("0.8.0\n");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "::error::crewhaus --version printed '0.8.0', expected '0.9.0-rc.1'",
    );
  });
});

/**
 * The digest commit's retry, run against a local bare repository. `bun` is stubbed
 * to run the real scripts/record-image-digests.ts (so the real recordDigest merges
 * the file) with `docker` stubbed to answer imagetools inspect with a digest.
 */
const HAVE_TOOLS = Bun.which("git") !== null && Bun.which("jq") !== null;
describe.skipIf(!HAVE_TOOLS && !process.env["CI"])(
  "the digest commit, against a main that moves while it runs",
  () => {
    const wf = load();
    const RECORD =
      stepNamed(wf.jobs["docker-digests"], "Record pushed digests into docker/digests.json")?.run ??
      "";
    const COMMIT =
      stepNamed(wf.jobs["docker-digests"], "Commit digests.json back to main")?.run ?? "";
    const DIGESTS = "packages/docker-images/docker/digests.json";

    function world() {
      const dir = tempDir("release-rc-digests-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeExec(
        join(bin, "bun"),
        `#!/bin/sh
[ "$1" = "scripts/record-image-digests.ts" ] || { echo "unexpected bun $*" >&2; exit 2; }
shift
printf '%s\\n' "$*" >> "$FAKE_BUN_LOG"
exec "$REAL_BUN" "$REAL_RECORD" "$@" --digests "$PWD/${DIGESTS}"
`,
      );
      writeExec(
        join(bin, "docker"),
        `#!/bin/sh
[ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "unexpected docker $*" >&2; exit 2; }
printf 'Name:      %s\\nMediaType: application/vnd.oci.image.index.v1+json\\nDigest:    sha256:%s\\n' "$4" "$FAKE_DIGEST"
`,
      );
      const home = join(dir, "home");
      mkdirSync(home);
      const env = (extra: Record<string, string> = {}): Record<string, string> => ({
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        REAL_BUN: process.execPath,
        REAL_RECORD: join(ROOT, "scripts", "record-image-digests.ts"),
        FAKE_BUN_LOG: join(dir, "bun.log"),
        FAKE_DIGEST: "b".repeat(64),
        ...extra,
      });
      const git = (cwd: string, ...args: string[]) => {
        const r = Bun.spawnSync(
          ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
          {
            cwd,
            env: env(),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
        return r.stdout.toString();
      };
      // origin: main holds a digests.json with one release recorded.
      const origin = join(dir, "origin.git");
      git(dir, "init", "-q", "--bare", "--initial-branch=main", origin);
      const seed = join(dir, "seed");
      git(dir, "clone", "-q", origin, seed);
      mkdirSync(join(seed, dirname(DIGESTS)), { recursive: true });
      const initial = {
        _comment: "Pinned image digests.",
        _format_version: 1,
        cli: {
          "0.8.0": { sha256: `sha256:${"a".repeat(64)}`, builtAt: "2026-10-25T00:00:00.000Z" },
        },
      };
      writeFileSync(join(seed, DIGESTS), `${JSON.stringify(initial, null, 2)}\n`);
      git(seed, "add", DIGESTS);
      git(seed, "commit", "-q", "-m", "seed");
      git(seed, "push", "-q", "origin", "HEAD:main");
      return { dir, origin, env, git };
    }

    /** The job: clone main, run the record step, let `meanwhile` move main, run the commit step. */
    function job(w: ReturnType<typeof world>, meanwhile: () => void): Run {
      const checkout = join(w.dir, "job");
      w.git(w.dir, "clone", "-q", w.origin, checkout);
      const stepEnv = w.env({ VERSION: "0.9.0", TARGETS_JSON: '["cli"]' });
      const recorded = runStep(RECORD, { cwd: checkout, env: stepEnv });
      expect(recorded.stderr).toBe("");
      expect(recorded.exitCode).toBe(0);
      meanwhile();
      return runStep(COMMIT, { cwd: checkout, env: stepEnv });
    }

    /** Another release's digest commit, landing on main after the job cloned it. */
    function competingCommit(w: ReturnType<typeof world>): void {
      const other = join(w.dir, "other");
      w.git(w.dir, "clone", "-q", w.origin, other);
      const r = Bun.spawnSync(
        [
          process.execPath,
          join(ROOT, "scripts", "record-image-digests.ts"),
          "--version",
          "0.8.1",
          "--targets",
          "cli",
          "--digests",
          join(other, DIGESTS),
        ],
        {
          cwd: other,
          env: w.env(),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(r.exitCode).toBe(0);
      w.git(other, "commit", "-q", "-am", "chore(release): record GHCR image digests for v0.8.1");
      w.git(other, "push", "-q", "origin", "HEAD:main");
    }

    const mainDigests = (w: ReturnType<typeof world>) =>
      JSON.parse(w.git(w.dir, "--git-dir", w.origin, "show", `main:${DIGESTS}`)) as {
        _comment: string;
        _format_version: number;
        cli: Record<string, { sha256: string }>;
      };

    test("a competing digest commit: the push lands on a fresh main, holding both commits' keys", () => {
      const w = world();
      const r = job(w, () => competingCommit(w));
      expect(r.stderr).not.toContain("CONFLICT");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(
        "push attempt 1 failed — re-recording on a fresh origin/main and retrying",
      );
      const digests = mainDigests(w);
      expect(Object.keys(digests.cli)).toEqual(["0.8.0", "0.8.1", "0.9.0"]);
      expect(digests._comment).toBe("Pinned image digests.");
      expect(digests._format_version).toBe(1);
      expect(digests.cli["0.9.0"]?.sha256).toBe(`sha256:${"b".repeat(64)}`);
      // Re-recorded once, for exactly the docker job's targets; never a rebase.
      expect(lines(join(w.dir, "bun.log"))).toEqual([
        "--version 0.9.0 --targets cli",
        "--version 0.9.0 --targets cli",
      ]);
      expect(
        w.git(w.dir, "--git-dir", w.origin, "log", "--format=%s", "main").trim().split("\n"),
      ).toEqual([
        "chore(release): record GHCR image digests for v0.9.0",
        "chore(release): record GHCR image digests for v0.8.1",
        "seed",
      ]);
    }, 30_000);

    test("a main that does not move: one push, no re-record", () => {
      const w = world();
      const r = job(w, () => {});
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("push attempt");
      expect(lines(join(w.dir, "bun.log"))).toEqual(["--version 0.9.0 --targets cli"]);
      expect(Object.keys(mainDigests(w).cli)).toEqual(["0.8.0", "0.9.0"]);
    }, 30_000);

    test("a main that refuses every push: three attempts, two re-records, then the error", () => {
      const w = world();
      writeExec(
        join(w.origin, "hooks", "pre-receive"),
        "#!/bin/sh\necho 'refused by the fixture' >&2\nexit 1\n",
      );
      const r = job(w, () => {});
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("::error::could not push digests.json to main after 3 attempts");
      expect(r.stdout).toContain("push attempt 2 failed");
      expect(r.stdout).not.toContain("push attempt 3 failed");
      expect(lines(join(w.dir, "bun.log"))).toHaveLength(3);
    }, 30_000);
  },
);
