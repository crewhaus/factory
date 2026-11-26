/**
 * The publish engine: an accepted work item as one pull request, from an isolated checkout.
 *
 * One managed bare clone per binding (`.crewhaus/workspaces/<binding>/repo`), one worktree per
 * item (`…/wt/<name>`) on a branch minted once, and one attempt at a time. Every refusal is
 * decided before anything is written to the code host; every step that reaches it is recorded
 * first, so a process that dies is settled from the records and the host, and never makes a
 * second pull request.
 *
 * The order of a publish: the hold, the attempt, the agent's uncommitted work as one commit,
 * something to publish, the size limits, the base (rebased onto when it moved, or refused),
 * the checks for the exact head, what leaves, the acceptance check, the push under a lease on
 * the branch this harness last pushed, and the pull request, found by its branch before one is
 * made.
 *
 * The engine works in `harnessDir` and never changes the process's directory. It reads a
 * binding from the active build (in the harness) or from what that build wrote (in Home),
 * and never from a worktree. Argv holds fixed words, minted branches, full SHAs and the URL
 * built from the binding: no model text and no request body.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type TrustOrigin, classifyBoundary } from "@crewhaus/boundary-classifier";
import type {
  WorkPublishCode,
  WorkPublishState,
  WorkPublishVerdict,
  WorkPublishWhy,
} from "@crewhaus/control-contract";
import { type LeaseProbe, ensureDigestKey, keyedDigest } from "@crewhaus/control-records";
import { maskCredentialTokens } from "@crewhaus/ir/redact";
import type { RunContext } from "@crewhaus/run-context";
import {
  type CheckedOrigin,
  CodehostOriginError,
  type CredentialProvider,
  assertCodehostOrigin,
  tokenEnvProvider,
} from "@crewhaus/tool-codehost/credentials";
import {
  type PullFailure,
  type PullInfo,
  type RepoName,
  createPull,
  findPullByHead,
  parseRepoName,
  updatePull,
  withPullsCall,
} from "@crewhaus/tool-codehost/pulls";
import { type GitRun, runGit } from "@crewhaus/tool-git/run";
import { ensureDirContained } from "@crewhaus/tool-safety/fs";
import {
  type FoldedAttempt,
  type FoldedWorkItem,
  type FoldedWorkspace,
  type PublishLine,
  type WorkActor,
  type WorkRevision,
  type WorkTextField,
  type WorkspaceLine,
  openWorkStore,
  readAttempts,
  readWorkspaces,
} from "../work-items/index";
import { type AcceptanceJudge, type Classify, acceptanceCheck } from "./acceptance";
import {
  type BindingsFile,
  type DeclaredIntent,
  type RepositoryBinding,
  WORKSPACES_DIR,
  WorkspaceConfigError,
  assertHarnessCwd,
  bindingDirOf,
  isInside,
} from "./bindings";
import {
  type CheckResult,
  type CheckRunner,
  NO_SANDBOX_REMEDY,
  checkName,
  runDeclaredChecks,
  sandboxCheckRunner,
} from "./checks";
import { credentialValues, lineageAllows, scanLineage, scanSecrets, secretIn } from "./egress";
import {
  type AddedLine,
  DIFF_MAX_CHARS,
  type DiffStat,
  type GitCall,
  type GitContext,
  type GitPort,
  type NetworkGit,
  SHA_RE,
  git,
  gitIsRecent,
  networkFailure,
  parseAddedLines,
  parseNumstat,
  strangeConfigKeys,
} from "./git";
import { type PublishText, pullBody, pullTitle } from "./pr-body";
import {
  appendAttempt,
  appendWorkspace,
  nextAttempt,
  readCheckFile,
  removeContainedDir,
  takePublishHold,
  workspaceNameTaken,
  worktreeNameOf,
  writeCheckFile,
} from "./records";

/** How long one call to the code host's API may take. */
export const API_TIMEOUT_MS = 30_000;

/** A step that could not be made: git answered with something nobody expected. */
export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

/** Who asks, as the records keep it. */
export type EngineActor = Pick<WorkActor, "by" | "via" | "role" | "run" | "cmd">;

export type WorkspaceRefusal = {
  readonly ok: false;
  readonly code: WorkPublishCode;
  /** What happened and what to do. Never a judge's words, a secret or a path outside the item. */
  readonly message: string;
  readonly attempt?: number;
  readonly verdict?: WorkPublishVerdict;
  readonly files?: number;
  readonly lines?: number;
  readonly file?: string;
  readonly line?: number;
  /** For `over_limits`: what a decision on this change is about. */
  readonly limits?: OverLimits;
  /** The cause behind `code`, where the code alone does not say what to do. */
  readonly why?: WorkPublishWhy;
};

export type OpenAnswer =
  | {
      readonly ok: true;
      readonly binding: string;
      readonly branch: string;
      readonly baseSha: string;
      /** Relative to the harness directory. */
      readonly worktree: string;
      readonly reused: boolean;
    }
  | WorkspaceRefusal;

export type CheckAnswerView = {
  readonly check: string;
  readonly exit: number;
  readonly log: string;
  readonly output: string;
};

export type CheckAnswer =
  | {
      readonly ok: true;
      readonly results: readonly CheckAnswerView[];
      /** The head these results count for; absent when the worktree held uncommitted work. */
      readonly headSha?: string;
    }
  | WorkspaceRefusal;

export type PublishAnswer =
  | {
      readonly ok: true;
      readonly attempt: number;
      readonly state: WorkPublishState;
      readonly pr?: number;
      readonly verdict: WorkPublishVerdict;
      readonly rebased: boolean;
    }
  | (WorkspaceRefusal & { readonly state?: WorkPublishState });

/** A change past the binding's limits: the counts a person decides on. */
export type OverLimits = {
  readonly wi: string;
  readonly repository: string;
  readonly branch: string;
  readonly files: number;
  readonly lines: number;
  readonly maxFiles: number;
  readonly maxLines: number;
  /** A digest of what the change adds and removes: the same across a clean rebase. */
  readonly change: string;
};

/** Whether a person already decided that this change may go out despite its size. */
export type LimitsPort = (
  over: OverLimits,
) => Promise<
  { readonly approved: false } | { readonly approved: true; readonly spend: () => Promise<boolean> }
>;

export type PublishInput = {
  readonly wi: string;
  readonly actor: EngineActor;
  /** What the agent says. Absent in Home, which repeats what the last attempt said. */
  readonly text?: PublishText;
  /** `harness` judges and checks; `home` publishes only what a harness run already judged. */
  readonly mode: "harness" | "home";
  readonly rc?: RunContext;
  readonly judge?: AcceptanceJudge;
  readonly intent?: DeclaredIntent;
  readonly limits?: LimitsPort;
  readonly decisions?: readonly string[];
  readonly signal?: AbortSignal;
};

export type EngineDeps = {
  readonly harnessDir: string;
  /** The bindings: the active build's, or what it wrote for Home. */
  readonly bindings: () => BindingsFile | { readonly problem: string } | undefined;
  readonly git?: GitPort;
  /** Where a token comes from; the variable the bindings name, read from `env`, by default. */
  readonly provider?: CredentialProvider;
  /** The harness's own environment. Home passes the files the harness is started with. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What runs a check; the configured sandbox by default, `null` for none. */
  readonly checkRunner?: CheckRunner | null;
  readonly classify?: Classify;
  readonly now?: () => number;
  readonly probe?: LeaseProbe;
  /** The harness's name, as its commits carry it. */
  readonly name?: string;
  readonly apiTimeoutMs?: number;
  /** Home's page for an item, when the harness knows where Home is. */
  readonly homeLink?: (wi: string) => string | undefined;
};

export type WorkspaceEngine = {
  open(
    wi: string,
    opts: {
      readonly actor: EngineActor;
      readonly repository?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<OpenAnswer>;
  check(
    wi: string,
    opts: { readonly actor: EngineActor; readonly signal?: AbortSignal },
  ): Promise<CheckAnswer>;
  publish(input: PublishInput): Promise<PublishAnswer>;
  /** Settle one attempt whose outcome is not known: look the pull request up by its branch. */
  reconcile(
    wi: string,
    attempt: number,
    opts: { readonly actor: EngineActor; readonly signal?: AbortSignal },
  ): Promise<FoldedAttempt | undefined>;
  /**
   * Settle an item's newest attempt when nobody is making it any more: one left `started` or
   * `pushed` by a process that stopped becomes `unknown`, and an `unknown` one is looked up.
   * A publish that is running is left alone.
   */
  settle(
    wi: string,
    opts: { readonly actor: EngineActor; readonly signal?: AbortSignal },
  ): Promise<FoldedAttempt | undefined>;
  close(
    wi: string,
    opts: { readonly actor: EngineActor; readonly signal?: AbortSignal },
  ): Promise<{ readonly closed: boolean; readonly wip: boolean }>;
};

/** Which runners found a git new enough, so its version is read once per process. */
const recentGit = new WeakSet<GitPort>();

const SLUG_MAX = 40;

function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "change" : slug;
}

/** A digest of what a change adds and removes, without its line numbers. */
function changeDigest(diff: string): string {
  const h = createHash("sha256");
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ") || line.startsWith("index ")) continue;
    h.update(line);
    h.update("\n");
  }
  return h.digest("hex");
}

export function createWorkspaceEngine(deps: EngineDeps): WorkspaceEngine {
  const { harnessDir } = deps;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const run: GitPort = deps.git ?? runGit;
  const classify: Classify =
    deps.classify ??
    ((text: string, opts: { readonly origin: TrustOrigin }) => classifyBoundary(text, opts));
  const apiTimeoutMs = deps.apiTimeoutMs ?? API_TIMEOUT_MS;

  const stamp = (): string => new Date(now()).toISOString();
  const refuse = (
    code: WorkPublishCode,
    message: string,
    more: Partial<WorkspaceRefusal> = {},
  ): WorkspaceRefusal => ({ ok: false, code, message, ...more });

  const bindingsNow = (): BindingsFile => {
    const b = deps.bindings();
    if (b === undefined) {
      throw new WorkspaceConfigError(
        "This harness has written no repository bindings. Start it once with a build that declares repositories.",
      );
    }
    if ("problem" in b) throw new WorkspaceConfigError(b.problem);
    return b;
  };

  const gitContext = (): GitContext => {
    const b = deps.bindings();
    const tokenEnv = b !== undefined && "repositories" in b ? b.tokenEnv : undefined;
    return { run, ...(tokenEnv !== undefined ? { tokenEnv } : {}) };
  };

  const step = (call: GitCall): Promise<GitRun> =>
    git(gitContext(), { ...(deps.name !== undefined ? { identity: deps.name } : {}), ...call });

  /** A step that must succeed: its failure is git's own last words, masked. */
  const must = async (call: GitCall, what: string): Promise<string> => {
    const done = await step(call);
    if (done.code !== 0) {
      const last = done.stderr.trim().split("\n").at(-1) ?? "";
      throw new WorkspaceError(
        `${what} failed${done.timedOut ? " (it took too long)" : ""}: ${redact(last).slice(0, 300)}`,
      );
    }
    return done.stdout;
  };

  const sha = async (call: Omit<GitCall, "args">, rev: string): Promise<string | undefined> => {
    const done = await step({
      ...call,
      args: ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
    });
    const text = done.stdout.trim();
    return done.code === 0 && SHA_RE.test(text) ? text : undefined;
  };

  /** Text with every credential this harness holds, and everything credential-shaped, masked. */
  function redact(text: string, extra: readonly string[] = []): string {
    let out = text;
    for (const value of [...extra, ...credentialValues(env)]) out = out.split(value).join("***");
    return maskCredentialTokens(out);
  }

  async function digestOf(wi: string, file: string): Promise<string | undefined> {
    const key = await ensureDigestKey(harnessDir);
    return key.state === "present" ? keyedDigest(key.hmac, "work-file", [wi, file]) : undefined;
  }

  async function gitReady(): Promise<WorkspaceRefusal | undefined> {
    if (recentGit.has(run)) return undefined;
    const done = await run(["--version"], { cwd: harnessDir, timeoutMs: 10_000 });
    if (done.code === 0 && gitIsRecent(done.stdout)) {
      recentGit.add(run);
      return undefined;
    }
    const found = done.stdout.trim() === "" ? "no git" : done.stdout.trim();
    return refuse(
      "unsupported_host",
      `Workspaces need git 2.38 or newer on this computer; it has ${found}.`,
      { why: "git-too-old" },
    );
  }

  /** The item, when it may be worked on. */
  function acceptedItem(
    wi: string,
  ): { readonly item: FoldedWorkItem; readonly revision: WorkRevision } | WorkspaceRefusal {
    const read = openWorkStore(harnessDir, { now }).get(wi);
    if ("ok" in read) return refuse("not_accepted", read.message);
    if (read.item.state !== "open") {
      return refuse(
        "not_accepted",
        read.item.state === "proposed"
          ? "This item is proposed: a person, or the owner's policy, accepts it first."
          : "This item is closed: a person reopens it first.",
      );
    }
    if (read.revision === undefined) {
      return refuse("not_accepted", "This item's content could not be read.");
    }
    return { item: read.item, revision: read.revision };
  }

  function bindingNamed(name: string): RepositoryBinding | undefined {
    return bindingsNow().repositories.find((r) => r.name === name);
  }

  /** The binding an item's work goes to: its workspace's, else the one asked for or declared. */
  function chooseBinding(
    ws: FoldedWorkspace | undefined,
    asked: string | undefined,
  ): RepositoryBinding | WorkspaceRefusal {
    const all = bindingsNow().repositories;
    const names = all.map((r) => r.name).join(", ");
    if (ws !== undefined) {
      const held = bindingNamed(ws.binding);
      if (held === undefined) {
        return refuse(
          "unsupported_host",
          `This item's workspace is in ${ws.binding}, which the harness no longer declares (it declares ${names}).`,
          { why: "repository-gone" },
        );
      }
      if (asked !== undefined && asked !== ws.binding) {
        return refuse("unsupported_host", `This item's workspace is already in ${ws.binding}.`, {
          why: "repository-elsewhere",
        });
      }
      return held;
    }
    if (asked !== undefined) {
      return (
        bindingNamed(asked) ??
        refuse(
          "unsupported_host",
          `No repository is called ${asked}: the harness declares ${names}.`,
          { why: "repository-unknown" },
        )
      );
    }
    const only = all[0];
    if (only === undefined || all.length !== 1) {
      return refuse(
        "unsupported_host",
        `This harness declares several repositories: name one of ${names}.`,
        { why: "repository-ambiguous" },
      );
    }
    return only;
  }

  type Paths = {
    readonly repoDir: string;
    readonly worktree: string;
    /** Relative to the harness directory. */
    readonly worktreeRel: string;
  };

  function pathsFor(binding: RepositoryBinding, name: string): Paths {
    const made = ensureDirContained(harnessDir, join(bindingDirOf(binding.name), "wt"), {
      mode: 0o700,
    });
    if (!made.ok) throw new WorkspaceError(made.reason);
    const bindingDir = join(made.real, "..");
    return {
      repoDir: join(bindingDir, "repo"),
      worktree: join(made.real, name),
      worktreeRel: join(bindingDirOf(binding.name), "wt", name),
    };
  }

  /** A worktree that is there: a directory, never a link, inside the workspaces. */
  function worktreeReady(paths: Paths): boolean {
    try {
      if (!lstatSync(paths.worktree).isDirectory()) return false;
      const root = realpathSync(join(harnessDir, WORKSPACES_DIR));
      return (
        isInside(root, realpathSync(paths.worktree)) &&
        existsSync(join(paths.repoDir, "worktrees", worktreeName(paths), "HEAD"))
      );
    } catch {
      return false;
    }
  }

  const worktreeName = (paths: Paths): string => paths.worktree.split(/[\\/]/).at(-1) ?? "";

  type Host = NetworkGit & {
    readonly api: string;
    readonly apiLoopback: boolean;
    readonly url: string;
    readonly repo: RepoName;
    readonly repoName: string;
  };

  /** The code host, checked, and a token for it: what every network step needs. */
  async function hostFor(
    binding: RepositoryBinding,
    signal: AbortSignal | undefined,
  ): Promise<Host | WorkspaceRefusal> {
    const allowLoopback = binding.allowPrivateTarget === true;
    const opts = { allowLoopback, ...(signal !== undefined ? { signal } : {}) };
    let gitOrigin: CheckedOrigin;
    let apiOrigin: CheckedOrigin;
    try {
      gitOrigin = await assertCodehostOrigin(binding.server.git, opts);
      apiOrigin = await assertCodehostOrigin(binding.server.api, opts);
    } catch (err) {
      if (!(err instanceof CodehostOriginError)) throw err;
      return refuse("unsupported_host", err.message, { why: "host-not-allowed" });
    }
    const repo = parseRepoName(binding.repo);
    if (repo === undefined) {
      return refuse("unsupported_host", "The repository is owner/name.", {
        why: "host-not-allowed",
      });
    }
    const provider = deps.provider ?? tokenEnvProvider({ tokenEnv: bindingsNow().tokenEnv, env });
    const credential = await provider({ origin: apiOrigin.origin, repo: binding.repo });
    if (!credential.ok) return refuse(credential.code, credential.message);
    return {
      origin: gitOrigin.origin,
      loopback: gitOrigin.loopback,
      token: credential.token,
      api: apiOrigin.origin,
      apiLoopback: apiOrigin.loopback,
      url: `${gitOrigin.origin}/${binding.repo}.git`,
      repo,
      repoName: binding.repo,
    };
  }

  function networkRefusal(done: GitRun, what: string): WorkspaceRefusal {
    const failure = networkFailure(done);
    switch (failure) {
      case "credential":
        return refuse(
          "credential_unavailable",
          `${what}: the code host refused the credential, or it cannot see this repository.`,
        );
      case "timeout":
        return refuse("unsupported_host", `${what}: the code host did not answer in time.`, {
          why: "host-timeout",
        });
      default:
        return refuse(
          "unsupported_host",
          `${what}: ${redact(done.stderr.trim().split("\n").at(-1) ?? "git failed").slice(0, 200)}`,
          { why: failure === "host" ? "host-unreachable" : "host-refused" },
        );
    }
  }

  /**
   * Whether the managed clone's own configuration still holds only what git writes when it
   * makes one. Anything else could send a network call somewhere else or through something
   * else, so no credential is handed to it.
   */
  async function cloneSteered(
    paths: Paths,
    binding: RepositoryBinding,
  ): Promise<WorkspaceRefusal | undefined> {
    const done = await step({
      repoDir: paths.repoDir,
      args: ["config", "--local", "--no-includes", "--null", "--name-only", "--list"],
    });
    const strange = done.code === 0 ? strangeConfigKeys(done.stdout) : ["unreadable"];
    if (strange.length === 0) return undefined;
    return refuse(
      "unsupported_host",
      `The managed clone of ${binding.repo} has git settings this harness did not make (${strange.slice(0, 5).join(", ")}), so it talks to no code host. A person removes them from ${join(bindingDirOf(binding.name), "repo", "config")}.`,
      { why: "clone-settings" },
    );
  }

  /** Make the bare clone once, and bring its copy of the base up to date. */
  async function fetchBase(
    binding: RepositoryBinding,
    paths: Paths,
    host: Host,
    signal: AbortSignal | undefined,
  ): Promise<string | WorkspaceRefusal> {
    const more = signal !== undefined ? { signal } : {};
    if (!existsSync(join(paths.repoDir, "HEAD"))) {
      await must(
        {
          cwd: join(paths.repoDir, ".."),
          args: ["init", "--quiet", "--bare", "--template=", paths.repoDir],
          ...more,
        },
        "Making the managed clone",
      );
    }
    const steered = await cloneSteered(paths, binding);
    if (steered !== undefined) return steered;
    for (let tries = 0; ; tries += 1) {
      const done = await step({
        repoDir: paths.repoDir,
        network: host,
        args: [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          host.url,
          `+refs/heads/${binding.base}:refs/remotes/origin/${binding.base}`,
        ],
        ...more,
      });
      if (done.code === 0) break;
      // Two items fetching at once: the other one's update is as good as this one's.
      if (tries < 2 && /cannot lock ref|unable to update local ref/i.test(done.stderr)) continue;
      return networkRefusal(done, `Reading ${binding.base} of ${binding.repo}`);
    }
    const at = await sha({ repoDir: paths.repoDir }, `refs/remotes/origin/${binding.base}`);
    return (
      at ??
      refuse("unsupported_host", `${binding.repo} has no branch ${binding.base}.`, {
        why: "base-missing",
      })
    );
  }

  async function line(
    ws: Pick<FoldedWorkspace, "binding" | "branch">,
    wi: string,
    actor: EngineActor,
    fields: Pick<WorkspaceLine, "state" | "event"> & Partial<WorkspaceLine>,
  ): Promise<void> {
    await appendWorkspace(harnessDir, {
      v: 1,
      at: stamp(),
      id: wi,
      by: actor.by,
      via: actor.via,
      ...(actor.run !== undefined ? { run: actor.run } : {}),
      binding: ws.binding,
      branch: ws.branch,
      ...fields,
    });
  }

  /** Leave a worktree as git left it before a rebase that never ended. */
  async function settleRebase(paths: Paths): Promise<void> {
    const admin = join(paths.repoDir, "worktrees", worktreeName(paths));
    if (existsSync(join(admin, "rebase-merge")) || existsSync(join(admin, "rebase-apply"))) {
      await step({ ...at(paths), args: ["rebase", "--abort"] });
    }
  }

  const at = (paths: Paths): { readonly repoDir: string; readonly worktree: string } => ({
    repoDir: paths.repoDir,
    worktree: paths.worktree,
  });

  async function isClean(paths: Paths): Promise<boolean> {
    const out = await must(
      {
        ...at(paths),
        args: ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"],
      },
      "Reading the worktree",
    );
    return out.trim() === "";
  }

  async function commitAll(paths: Paths, message: string): Promise<void> {
    await must({ ...at(paths), args: ["add", "--all", "--", "."] }, "Staging the change");
    await must(
      {
        ...at(paths),
        args: ["commit", "--quiet", "--no-verify", "--cleanup=whitespace", "--file=-"],
        stdin: message,
      },
      "Committing the change",
    );
  }

  async function open(
    wi: string,
    opts: { actor: EngineActor; repository?: string; signal?: AbortSignal },
  ): Promise<OpenAnswer> {
    assertHarnessCwd(harnessDir);
    const accepted = acceptedItem(wi);
    if ("ok" in accepted) return accepted;
    const unready = await gitReady();
    if (unready !== undefined) return unready;
    const workspaces = readWorkspaces(harnessDir);
    const ws = workspaces.get(wi);
    const binding = chooseBinding(ws, opts.repository);
    if ("ok" in binding) return binding;
    const ulid = wi.slice("wi_".length).toLowerCase();
    const short = ulid.slice(0, 10);
    const name =
      ws !== undefined
        ? worktreeNameOf(ws.branch)
        : workspaceNameTaken(workspaces, wi, short)
          ? ulid
          : short;
    const branch =
      ws?.branch ?? `${binding.branchPrefix}${name}-${slugOf(accepted.revision.title)}`;
    const paths = pathsFor(binding, name);
    if (ws?.state === "open" && ws.baseSha !== undefined && worktreeReady(paths)) {
      await settleRebase(paths);
      return {
        ok: true,
        binding: binding.name,
        branch,
        baseSha: ws.baseSha,
        worktree: paths.worktreeRel,
        reused: true,
      };
    }
    const host = await hostFor(binding, opts.signal);
    if ("ok" in host) return host;
    const fetched = await fetchBase(binding, paths, host, opts.signal);
    if (typeof fetched !== "string") return fetched;
    const have = await sha({ repoDir: paths.repoDir }, `refs/heads/${branch}`);
    const baseSha =
      have === undefined ? fetched : await mergeBase(paths.repoDir, have, fetched, fetched);
    await step({ repoDir: paths.repoDir, args: ["worktree", "prune"] });
    if (!worktreeReady(paths)) {
      removeContainedDir(harnessDir, paths.worktreeRel);
      await must(
        {
          repoDir: paths.repoDir,
          args:
            have === undefined
              ? ["worktree", "add", "--quiet", "--no-track", "-b", branch, paths.worktree, baseSha]
              : ["worktree", "add", "--quiet", paths.worktree, branch],
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
        "Making the worktree",
      );
    }
    const headSha = (await sha(at(paths), "HEAD")) ?? baseSha;
    await line({ binding: binding.name, branch }, wi, opts.actor, {
      state: "open",
      event: "opened",
      baseSha,
      headSha,
    });
    return {
      ok: true,
      binding: binding.name,
      branch,
      baseSha,
      worktree: paths.worktreeRel,
      reused: false,
    };
  }

  async function mergeBase(
    repoDir: string,
    head: string,
    base: string,
    fallback: string,
  ): Promise<string> {
    const done = await step({ repoDir, args: ["merge-base", base, head] });
    const text = done.stdout.trim();
    return done.code === 0 && SHA_RE.test(text) ? text : fallback;
  }

  /** The item's open workspace, with its paths. */
  function openWorkspace(
    wi: string,
  ):
    | { readonly ws: FoldedWorkspace; readonly binding: RepositoryBinding; readonly paths: Paths }
    | WorkspaceRefusal {
    const ws = readWorkspaces(harnessDir).get(wi);
    if (ws === undefined || ws.state !== "open") {
      return refuse("nothing_to_publish", "This item has no open workspace: open one first.");
    }
    const binding = chooseBinding(ws, undefined);
    if ("ok" in binding) return binding;
    const paths = pathsFor(binding, worktreeNameOf(ws.branch));
    if (!worktreeReady(paths)) {
      return refuse(
        "nothing_to_publish",
        "This item's worktree is gone: open its workspace again.",
      );
    }
    return { ws, binding, paths };
  }

  async function onBranch(paths: Paths, branch: string): Promise<boolean> {
    const done = await step({ ...at(paths), args: ["symbolic-ref", "--quiet", "HEAD"] });
    return done.stdout.trim() === `refs/heads/${branch}`;
  }

  const runner = (): CheckRunner | undefined =>
    deps.checkRunner === null ? undefined : (deps.checkRunner ?? sandboxCheckRunner(env));

  function writeLogs(
    wi: string,
    attempt: number,
    results: readonly CheckResult[],
  ): readonly CheckAnswerView[] {
    return results.map((r) => {
      const log = `${attempt}-${r.k}.log`;
      const output = redact(r.output);
      writeCheckFile(
        harnessDir,
        wi,
        log,
        `$ ${r.name}\n${output}${output.endsWith("\n") ? "" : "\n"}[exit ${r.exit}${r.timedOut ? ", timed out" : ""}]\n`,
      );
      return { check: r.name, exit: r.exit, log, output };
    });
  }

  async function check(
    wi: string,
    opts: { actor: EngineActor; signal?: AbortSignal },
  ): Promise<CheckAnswer> {
    assertHarnessCwd(harnessDir);
    const accepted = acceptedItem(wi);
    if ("ok" in accepted) return accepted;
    const unready = await gitReady();
    if (unready !== undefined) return unready;
    const opened = openWorkspace(wi);
    if ("ok" in opened) return opened;
    const { ws, binding, paths } = opened;
    if (binding.checks.length === 0) return { ok: true, results: [] };
    const runs = runner();
    if (runs === undefined) return refuse("gate_failed", NO_SANDBOX_REMEDY);
    // Results count for a commit only when the worktree held exactly that commit.
    const counted = (await isClean(paths)) && (await onBranch(paths, ws.branch));
    const headSha = counted ? await sha(at(paths), "HEAD") : undefined;
    const answer = await runDeclaredChecks({
      binding,
      worktree: paths.worktree,
      runner: runs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (!answer.ran) return refuse("gate_failed", answer.reason);
    const views = writeLogs(wi, nextAttempt(harnessDir, wi), answer.results);
    await line(ws, wi, opts.actor, {
      state: "open",
      event: "checked",
      ...(ws.baseSha !== undefined ? { baseSha: ws.baseSha } : {}),
      ...(headSha !== undefined ? { headSha } : {}),
      results: answer.results.map((r) => ({ k: r.k, exit: r.exit })),
    });
    return { ok: true, results: views, ...(headSha !== undefined ? { headSha } : {}) };
  }

  type Change = {
    readonly stat: DiffStat;
    readonly added: readonly AddedLine[];
    readonly files: readonly string[];
    readonly digest: string;
    readonly truncated: boolean;
  };

  async function readChange(paths: Paths, base: string, head: string): Promise<Change> {
    const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const { repoDir } = paths;
    const diff = await step({
      repoDir,
      args: ["diff", ...flags, "--unified=0", "--text", base, head],
      maxOutputChars: DIFF_MAX_CHARS,
    });
    if (diff.code !== 0) throw new WorkspaceError("Reading the change failed.");
    const numstat = await must(
      {
        repoDir,
        args: ["diff", ...flags, "--numstat", "-z", base, head],
        maxOutputChars: DIFF_MAX_CHARS,
      },
      "Counting the change",
    );
    const names = await must(
      {
        repoDir,
        args: ["diff", ...flags, "--name-only", "-z", base, head],
        maxOutputChars: DIFF_MAX_CHARS,
      },
      "Listing the change",
    );
    return {
      stat: parseNumstat(numstat),
      added: parseAddedLines(diff.stdout),
      files: names.split("\0").filter((n) => n !== ""),
      digest: changeDigest(diff.stdout),
      truncated: diff.truncated,
    };
  }

  /**
   * The one commit a publish pushes: `head`'s tree on `base`, with the publish's own message.
   * Its tree is exactly the change every gate read, and it carries none of the branch's own
   * commits. Its dates are `head`'s, so the same change and text make the same commit again.
   */
  async function publishedCommit(
    paths: Paths,
    base: string,
    head: string,
    message: string,
  ): Promise<string> {
    const { repoDir } = paths;
    const when = (
      await must({ repoDir, args: ["log", "-1", "--format=%ct", head] }, "Reading the change")
    ).trim();
    if (!/^\d{1,12}$/.test(when)) throw new WorkspaceError("The change's date could not be read.");
    const made = (
      await must(
        {
          repoDir,
          args: ["commit-tree", `${head}^{tree}`, "-p", base, "-F", "-"],
          stdin: message,
          date: `@${when} +0000`,
        },
        "Making the published commit",
      )
    ).trim();
    if (!SHA_RE.test(made)) throw new WorkspaceError("The published commit could not be read.");
    return made;
  }

  /** The text a publish goes out with: the agent's, or what the last attempt said. */
  function textFor(input: PublishInput, revision: WorkRevision): PublishText {
    if (input.text !== undefined) return input.text;
    const attempts = readAttempts(harnessDir).get(input.wi) ?? [];
    for (const attempt of [...attempts].reverse()) {
      const kept = readCheckFile(harnessDir, input.wi, `${attempt.attempt}-publish.json`);
      if (kept === undefined) continue;
      try {
        const body = JSON.parse(kept) as PublishText;
        if (typeof body.title === "string" && typeof body.summary === "string") return body;
      } catch {
        // Cut or unreadable: an older attempt, or the item's own title.
      }
    }
    return { title: revision.title, summary: revision.title };
  }

  /** The first hit in the pull request's own text, named as such. */
  async function textHit(
    whole: string,
    values: readonly string[],
    rc: RunContext | undefined,
    sinkId: string,
    own: readonly string[],
  ): Promise<WorkspaceRefusal | undefined> {
    for (const part of whole.split("\n")) {
      if (secretIn(part, values) !== undefined) {
        return refuse(
          "egress_blocked",
          "The pull request's text holds a credential. Write it without.",
        );
      }
    }
    if (rc !== undefined && !(await lineageAllows(whole, rc, { sinkId, own }))) {
      return refuse(
        "egress_blocked",
        "The pull request's text repeats words from a source that does not leave in a pull request. Say it in your own words.",
      );
    }
    return undefined;
  }

  /**
   * The item's own words, which its change may repeat: only what a person wrote, or accepted.
   * A title, goal or criterion counts when it came through the API, or when a person opened
   * or accepted the item (the harness edits nothing after that). A note or the assessment
   * counts only when it came through the API. Nothing the harness, a tool or an adopted
   * source wrote ever counts, so text a run copies into its own item stays its lineage.
   */
  const ownWords = (item: FoldedWorkItem, revision: WorkRevision): string[] => {
    const byPerson = item.history.some((l) => l.state === "open" && !l.by.startsWith("sys:"));
    const fromApi = (field: WorkTextField): boolean => revision.fieldOrigins[field] === "api";
    return [
      ...(byPerson || fromApi("title") ? [revision.title] : []),
      ...(revision.goal !== undefined && (byPerson || fromApi("goal")) ? [revision.goal] : []),
      ...(byPerson || fromApi("acceptance") ? (revision.acceptance ?? []) : []),
      ...(revision.notes ?? []).filter((n) => n.origin === "api").map((n) => n.text),
      ...(revision.assessment !== undefined && fromApi("assessment")
        ? [JSON.stringify(revision.assessment)]
        : []),
    ];
  };

  async function publish(input: PublishInput): Promise<PublishAnswer> {
    assertHarnessCwd(harnessDir);
    const { wi, actor, signal } = input;
    const accepted = acceptedItem(wi);
    if ("ok" in accepted) return accepted;
    const unready = await gitReady();
    if (unready !== undefined) return unready;
    const opened = openWorkspace(wi);
    if ("ok" in opened) return opened;
    const hold = await takePublishHold(harnessDir, wi, now, deps.probe);
    if (hold === undefined) {
      return refuse(
        "already_publishing",
        "This item is being published now. Wait for that attempt to end.",
      );
    }
    try {
      await settleAbandoned(wi, actor, signal);
      return await publishHeld(input, accepted, opened);
    } finally {
      await hold.release();
    }
  }

  /** An attempt nobody is making any more is unknown; look its pull request up before another. */
  async function settleAbandoned(
    wi: string,
    actor: EngineActor,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const last = readAttempts(harnessDir).get(wi)?.at(-1);
    if (last === undefined) return;
    if (last.state === "started" || last.state === "pushed") {
      await appendAttempt(harnessDir, {
        ...last,
        at: stamp(),
        state: "unknown",
        by: actor.by,
        via: actor.via,
      });
    } else if (last.state !== "unknown") return;
    await reconcile(wi, last.attempt, { actor, ...(signal !== undefined ? { signal } : {}) });
  }

  async function settle(
    wi: string,
    opts: { actor: EngineActor; signal?: AbortSignal },
  ): Promise<FoldedAttempt | undefined> {
    assertHarnessCwd(harnessDir);
    const newest = (): FoldedAttempt | undefined => readAttempts(harnessDir).get(wi)?.at(-1);
    const last = newest();
    if (last === undefined) return undefined;
    if (last.state !== "started" && last.state !== "pushed" && last.state !== "unknown") {
      return last;
    }
    const hold = await takePublishHold(harnessDir, wi, now, deps.probe);
    if (hold === undefined) return last;
    try {
      await settleAbandoned(wi, opts.actor, opts.signal);
    } finally {
      await hold.release();
    }
    return newest();
  }

  async function publishHeld(
    input: PublishInput,
    accepted: { readonly item: FoldedWorkItem; readonly revision: WorkRevision },
    opened: {
      readonly ws: FoldedWorkspace;
      readonly binding: RepositoryBinding;
      readonly paths: Paths;
    },
  ): Promise<PublishAnswer> {
    const { wi, actor, signal, mode } = input;
    const { ws, binding, paths } = opened;
    const { revision } = accepted;
    const more = signal !== undefined ? { signal } : {};
    const n = nextAttempt(harnessDir, wi);
    let attempt: PublishLine = {
      v: 1,
      at: stamp(),
      id: `${wi}:${n}`,
      wi,
      attempt: n,
      state: "started",
      by: actor.by,
      via: actor.via,
      ...(actor.cmd !== undefined ? { cmd: actor.cmd } : {}),
      ...(actor.run !== undefined ? { run: actor.run } : {}),
      branch: ws.branch,
      ...(ws.baseSha !== undefined ? { baseSha: ws.baseSha } : {}),
    };
    const record = async (fields: Partial<PublishLine>): Promise<void> => {
      attempt = { ...attempt, ...fields, at: stamp() };
      await appendAttempt(harnessDir, attempt);
    };
    const fail = async (
      refusal: WorkspaceRefusal,
      fields: Partial<PublishLine> = {},
    ): Promise<PublishAnswer> => {
      await record({
        ...fields,
        state: "failed",
        code: refusal.code,
        ...(refusal.why !== undefined ? { why: refusal.why } : {}),
      });
      return {
        ...refusal,
        attempt: n,
        state: "failed",
        ...(attempt.verdict !== undefined ? { verdict: attempt.verdict } : {}),
        ...(attempt.files !== undefined ? { files: attempt.files } : {}),
        ...(attempt.lines !== undefined ? { lines: attempt.lines } : {}),
      };
    };
    await appendAttempt(harnessDir, attempt);
    let written = false;
    try {
      await settleRebase(paths);
      if (!(await onBranch(paths, ws.branch))) {
        return await fail(
          refuse(
            "nothing_to_publish",
            `The worktree is not on its branch. Switch it back to ${ws.branch}, then publish.`,
          ),
        );
      }
      if (mode === "harness" && !(await isClean(paths))) {
        await commitAll(
          paths,
          `${pullTitle(input.text?.title ?? revision.title)}\n\nWork item: ${wi}\n`,
        );
      }
      let base = ws.baseSha ?? "";
      let head = (await sha({ repoDir: paths.repoDir }, `refs/heads/${ws.branch}`)) ?? "";
      if (!SHA_RE.test(base) || !SHA_RE.test(head)) {
        return await fail(
          refuse(
            "nothing_to_publish",
            "The branch or its base is missing: open the workspace again.",
          ),
        );
      }
      const ahead = await must(
        { repoDir: paths.repoDir, args: ["rev-list", "--count", `${base}..${head}`] },
        "Counting the commits",
      );
      if (Number.parseInt(ahead.trim(), 10) === 0) {
        return await fail(refuse("nothing_to_publish", "The branch has no change on it yet."), {
          headSha: head,
        });
      }
      let change = await readChange(paths, await mergeBase(paths.repoDir, head, base, base), head);
      if (change.files.length === 0) {
        return await fail(refuse("nothing_to_publish", "The branch changes nothing."), {
          headSha: head,
        });
      }
      await record({ headSha: head, files: change.stat.files, lines: change.stat.lines });

      // The size limits: a larger change waits for a person, with the counts.
      let spendLimits: (() => Promise<boolean>) | undefined;
      const limitsNow = async (): Promise<WorkspaceRefusal | undefined> => {
        const { maxFiles, maxLines } = binding.pullRequests;
        if (change.stat.files <= maxFiles && change.stat.lines <= maxLines) {
          spendLimits = undefined;
          return undefined;
        }
        const over: OverLimits = {
          wi,
          repository: binding.repo,
          branch: ws.branch,
          files: change.stat.files,
          lines: change.stat.lines,
          maxFiles,
          maxLines,
          change: change.digest,
        };
        const decided = await input.limits?.(over);
        if (decided?.approved === true) {
          spendLimits = decided.spend;
          return undefined;
        }
        return refuse(
          "over_limits",
          `The change is ${over.files} files and ${over.lines} lines, past this repository's limits (${maxFiles} files, ${maxLines} lines). A person decides whether it goes out.`,
          { limits: over, files: over.files, lines: over.lines },
        );
      };
      const past = await limitsNow();
      if (past !== undefined) return await fail(past);

      const host = await hostFor(binding, signal);
      if ("ok" in host) return await fail(host);
      const fetched = await fetchBase(binding, paths, host, signal);
      if (typeof fetched !== "string") return await fail(fetched);
      let rebased = false;
      const contains = await step({
        repoDir: paths.repoDir,
        args: ["merge-base", "--is-ancestor", fetched, head],
      });
      if (contains.code !== 0) {
        if (mode === "home") {
          return await fail(
            refuse(
              "gate_failed",
              "The base moved since this change was judged. Run the item again so the harness can rebase and check it.",
              { why: "base-moved" },
            ),
          );
        }
        if (binding.pullRequests.revalidate === "refresh") {
          await must(
            {
              repoDir: paths.repoDir,
              args: ["update-ref", `refs/crewhaus/superseded/${ws.branch}/${n}`, head],
            },
            "Keeping the earlier commits",
          );
          await must(
            { ...at(paths), args: ["reset", "--hard", "--quiet", fetched] },
            "Refreshing the branch",
          );
          await line(ws, wi, actor, {
            state: "open",
            event: "refreshed",
            baseSha: fetched,
            headSha: fetched,
          });
          return await fail(
            refuse(
              "conflicts_with_base",
              `The base moved, so ${ws.branch} was made again from it. Make the change again on the new base, then publish.`,
            ),
          );
        }
        const done = await step({
          ...at(paths),
          args: ["rebase", "--quiet", "--no-autosquash", fetched],
          ...more,
        });
        if (done.code !== 0) {
          await step({ ...at(paths), args: ["rebase", "--abort"] });
          return await fail(
            refuse(
              "conflicts_with_base",
              "The base moved and this change conflicts with it. Nothing was published. Make the change fit the new base, then publish.",
            ),
          );
        }
        rebased = true;
        head = (await sha({ repoDir: paths.repoDir }, `refs/heads/${ws.branch}`)) ?? "";
        if (!SHA_RE.test(head)) throw new WorkspaceError("The rebased branch could not be read.");
      }
      base = fetched;
      if (rebased || ws.baseSha !== fetched) {
        await line(ws, wi, actor, {
          state: "open",
          event: "refreshed",
          baseSha: fetched,
          headSha: head,
        });
      }
      change = await readChange(paths, base, head);
      if (change.files.length === 0) {
        return await fail(refuse("nothing_to_publish", "The base already holds this change."), {
          headSha: head,
          baseSha: base,
        });
      }
      await record({
        headSha: head,
        baseSha: base,
        files: change.stat.files,
        lines: change.stat.lines,
        ...(rebased ? { rebased: true as const } : {}),
      });
      const pastAfter = await limitsNow();
      if (pastAfter !== undefined) return await fail(pastAfter);

      const text = textFor(input, revision);
      let verdict: WorkPublishVerdict;
      let checks: readonly CheckResult[] | undefined;
      if (mode === "home") {
        const judged = [...(readAttempts(harnessDir).get(wi) ?? [])]
          .reverse()
          .find((a) => a.attempt !== n && a.verdict !== undefined && a.verdict.sha === head);
        const v = judged?.verdict;
        const required = binding.pullRequests.require;
        const passed =
          v !== undefined &&
          judged?.lineage === "pass" &&
          (!required.includes("checks") || v.checks === "pass") &&
          (!required.includes("acceptance") || v.acceptance === "pass");
        if (!passed || v === undefined) {
          return await fail(
            refuse(
              "gate_failed",
              `No run of this harness has judged this exact change and passed it. Run the item again: crewhaus work start ${wi}`,
              { why: "not-judged" },
            ),
          );
        }
        verdict = v;
        checks = binding.checks.map((argv, k) => ({
          k,
          name: checkName(argv),
          exit: 0,
          timedOut: false,
          output: "",
        }));
        if (v.checks !== "pass") checks = undefined;
        await record({ verdict, lineage: "pass" });
      } else {
        const needed =
          binding.checks.length > 0 &&
          (binding.pullRequests.require.includes("checks") ||
            (revision.acceptance ?? []).some((c) => /^check:/i.test(c.trim())));
        if (needed) {
          const recorded = readWorkspaces(harnessDir).get(wi)?.results.get(head);
          const allPassed =
            !rebased &&
            recorded !== undefined &&
            binding.checks.every((_argv, k) => recorded.some((r) => r.k === k && r.exit === 0));
          if (allPassed) {
            checks = binding.checks.map((argv, k) => ({
              k,
              name: checkName(argv),
              exit: 0,
              timedOut: false,
              output: "",
            }));
          } else {
            const answer = await runDeclaredChecks({
              binding,
              worktree: paths.worktree,
              runner: runner(),
              ...more,
            });
            if (answer.ran) {
              checks = answer.results;
              writeLogs(wi, n, answer.results);
              await line(ws, wi, actor, {
                state: "open",
                event: "checked",
                baseSha: base,
                headSha: head,
                results: answer.results.map((r) => ({ k: r.k, exit: r.exit })),
              });
            } else if (binding.pullRequests.require.includes("checks")) {
              return await fail(
                refuse("gate_failed", answer.reason, {
                  why: answer.reason === NO_SANDBOX_REMEDY ? "no-sandbox" : "sandbox-failed",
                }),
                {
                  verdict: {
                    checks: "not-run",
                    acceptance: binding.pullRequests.require.includes("acceptance")
                      ? "not-run"
                      : "not-required",
                    sha: head,
                  },
                },
              );
            }
          }
        }
        verdict = { checks: "skipped", acceptance: "not-run", sha: head };
      }

      // What leaves: one commit holding the change read above on the base it was read
      // against, its file names and message, and the pull request's own text. The branch's
      // own commits stay in this clone, so nothing a later commit took out goes with it.
      const message = `${pullTitle(text.title)}\n\nWork item: ${wi}\n`;
      const values = [...credentialValues(env), host.token];
      const sinkId = `codehost:${binding.repo}`;
      const own = ownWords(accepted.item, revision);
      if (change.truncated) {
        return await fail(
          refuse(
            "egress_blocked",
            "The change is too large to check for credentials before it leaves.",
          ),
        );
      }
      const hit =
        scanSecrets({ ...change, messages: message, values }) ??
        (input.rc !== undefined
          ? await scanLineage({ added: change.added, rc: input.rc, sinkId, own })
          : undefined);
      if (hit !== undefined) {
        const file = await digestOf(wi, hit.file);
        writeCheckFile(
          harnessDir,
          wi,
          `${n}-egress.log`,
          redact(`${hit.file}:${hit.line}: ${hit.why}\n`, values),
        );
        return await fail(
          refuse(
            "egress_blocked",
            `${redact(hit.file, values)}${hit.line > 0 ? `, line ${hit.line}` : ""}: ${hit.why}. Nothing was published.`,
            { file: redact(hit.file, values), line: hit.line },
          ),
          { ...(file !== undefined ? { file } : {}), ...(hit.line > 0 ? { line: hit.line } : {}) },
        );
      }
      const said = [text.title, text.summary, ...(text.concerns ?? [])].join("\n");
      const inText = await textHit(said, values, input.rc, sinkId, own);
      if (inText !== undefined) return await fail(inText);

      if (mode === "harness") {
        const answer = await acceptanceCheck({
          binding,
          revision,
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
          headSha: head,
          stat: change.stat,
          added: change.added,
          checks,
          judge: input.judge,
          classify,
          ...(input.rc !== undefined ? { rc: input.rc } : {}),
          ...more,
        });
        verdict = answer.verdict;
        const reasons =
          answer.reasons === undefined
            ? undefined
            : writeCheckFile(
                harnessDir,
                wi,
                `${n}-acceptance.log`,
                `${redact(answer.reasons, values)}\n`,
              );
        const recorded: Partial<PublishLine> = {
          verdict,
          ...(reasons !== undefined ? { reasons } : {}),
        };
        if (answer.refused !== undefined) {
          return await fail(
            refuse(answer.refused, answer.message ?? "The change did not pass."),
            recorded,
          );
        }
        writeCheckFile(
          harnessDir,
          wi,
          `${n}-publish.json`,
          JSON.stringify({
            title: text.title,
            summary: text.summary,
            ...(text.concerns !== undefined ? { concerns: text.concerns } : {}),
          }),
        );
        await record({ ...recorded, lineage: "pass" });
      }
      if (spendLimits !== undefined && !(await spendLimits())) {
        return await fail(
          refuse(
            "over_limits",
            "The decision on this change's size was already used. A person decides again.",
          ),
        );
      }
      if (signal?.aborted === true) throw new WorkspaceError("The publish was stopped.");
      const out = await publishedCommit(paths, base, head, message);
      await record({ pushedSha: out });

      // The whole text that goes out, read once more: nothing it was rendered from adds a secret.
      const link = deps.homeLink?.(wi);
      const body = pullBody({
        text,
        wi,
        ...(link !== undefined ? { homeLink: link } : {}),
        ...(revision.parent !== undefined ? { parent: revision.parent } : {}),
        ...(revision.source?.kind === "continuity-goal" && revision.source.ref !== undefined
          ? { plan: [revision.source.ref] }
          : {}),
        runs: accepted.item.runs,
        ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
        ...(checks !== undefined ? { checks } : {}),
        verdict,
        ...(rebased ? { rebasedOnto: base } : {}),
      });
      // Its words were checked against the run's lineage above; the rest are the records' own.
      const inBody = await textHit(body, values, undefined, sinkId, own);
      if (inBody !== undefined) return await fail(inBody);

      // The branch this harness last pushed is the only one it replaces.
      const steered = await cloneSteered(paths, binding);
      if (steered !== undefined) return await fail(steered);
      const remote = await step({
        repoDir: paths.repoDir,
        network: host,
        args: ["ls-remote", "--heads", host.url, `refs/heads/${ws.branch}`],
        ...more,
      });
      if (remote.code !== 0) return await fail(networkRefusal(remote, "Reading the branch"));
      const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
      if (remoteSha !== "") {
        const mine = new Set(
          (readAttempts(harnessDir).get(wi) ?? []).flatMap((a) => [
            ...(a.headSha !== undefined ? [a.headSha] : []),
            ...(a.pushedSha !== undefined ? [a.pushedSha] : []),
          ]),
        );
        if (!SHA_RE.test(remoteSha) || !mine.has(remoteSha)) {
          return await fail(
            refuse(
              "conflicts_with_base",
              `Someone changed ${ws.branch} on the code host, so it was left as it is. A person merges or closes that change first.`,
            ),
          );
        }
      }
      written = true;
      if (remoteSha !== out) {
        const pushed = await step({
          repoDir: paths.repoDir,
          network: host,
          args: [
            "push",
            "--quiet",
            "--no-verify",
            `--force-with-lease=refs/heads/${ws.branch}:${remoteSha}`,
            host.url,
            `${out}:refs/heads/${ws.branch}`,
          ],
          ...more,
        });
        if (pushed.code !== 0) {
          const why = networkFailure(pushed);
          if (why === "rejected") {
            return await fail(
              refuse(
                "conflicts_with_base",
                `${ws.branch} changed on the code host while it was being published, so it was left as it is.`,
              ),
            );
          }
          if (why === "credential") return await fail(networkRefusal(pushed, "Pushing the branch"));
          if (why === "host" && !pushed.timedOut) {
            return await fail(networkRefusal(pushed, "Pushing the branch"));
          }
          return await unknown(record, n, verdict, rebased);
        }
      }
      await record({ state: "pushed" });

      const opened2 = await openPull(host, binding, ws.branch, pullTitle(text.title), body, signal);
      if (opened2.kind === "unknown") return await unknown(record, n, verdict, rebased);
      if (opened2.kind === "refused") return await fail(opened2.refusal);
      await record({ state: "done", pr: opened2.pull.number });
      await deliverOnce(wi, binding.repo, opened2.pull.number, actor);
      return {
        ok: true,
        attempt: n,
        state: "done",
        pr: opened2.pull.number,
        verdict,
        rebased,
      };
    } catch (err) {
      const state = attempt.state;
      if (state === "started" || state === "pushed") {
        await record({ state: written ? "unknown" : "failed" }).catch(() => undefined);
      }
      throw err;
    }
  }

  async function unknown(
    record: (fields: Partial<PublishLine>) => Promise<void>,
    n: number,
    verdict: WorkPublishVerdict,
    rebased: boolean,
  ): Promise<PublishAnswer> {
    await record({ state: "unknown" });
    return { ok: true, attempt: n, state: "unknown", verdict, rebased };
  }

  type PullOutcome =
    | { readonly kind: "open"; readonly pull: PullInfo }
    | { readonly kind: "refused"; readonly refusal: WorkspaceRefusal }
    | { readonly kind: "unknown" };

  /** A definite answer from the host, as a refusal; anything that may have landed is unknown. */
  function pullRefusal(failure: PullFailure): PullOutcome {
    // A success nobody could read may have landed, as may anything the host stumbled on.
    const landed = failure.status < 400 || failure.status >= 500;
    if (failure.rateLimited === true || landed) return { kind: "unknown" };
    if (failure.status === 401 || failure.status === 403) {
      return {
        kind: "refused",
        refusal: refuse(
          "credential_unavailable",
          "The code host refused the credential for pull requests.",
        ),
      };
    }
    if (failure.status === 422) {
      return {
        kind: "refused",
        refusal: refuse(
          "nothing_to_publish",
          "The code host says there is nothing to propose from this branch.",
        ),
      };
    }
    return {
      kind: "refused",
      refusal: refuse("unsupported_host", `${failure.message}.`, { why: "host-refused" }),
    };
  }

  /** Create the pull request, or update the open one the branch already has. */
  async function openPull(
    host: Host,
    binding: RepositoryBinding,
    branch: string,
    title: string,
    body: string,
    signal: AbortSignal | undefined,
  ): Promise<PullOutcome> {
    const call = {
      apiBase: host.api,
      token: host.token,
      timeoutMs: apiTimeoutMs,
      allowLoopback: host.apiLoopback,
      ...(signal !== undefined ? { signal } : {}),
    };
    try {
      return await withPullsCall(call, async (c): Promise<PullOutcome> => {
        const found = await findPullByHead(c, host.repo, branch);
        if (!found.ok) return pullRefusal(found);
        const update = async (number: number): Promise<PullOutcome> => {
          const done = await updatePull(c, host.repo, number, { title, body });
          return done.ok ? { kind: "open", pull: done.pull } : pullRefusal(done);
        };
        if (found.pull?.state === "open") return update(found.pull.number);
        const made = await createPull(c, host.repo, {
          title,
          head: branch,
          base: binding.base,
          body,
          draft: binding.pullRequests.draft,
        });
        if (made.ok) return { kind: "open", pull: made.pull };
        if (!("exists" in made)) return pullRefusal(made);
        const again = await findPullByHead(c, host.repo, branch);
        if (!again.ok) return pullRefusal(again);
        return again.pull?.state === "open" ? update(again.pull.number) : { kind: "unknown" };
      });
    } catch {
      // An answer that was lost: the host may have made it.
      return { kind: "unknown" };
    }
  }

  /** Record the delivery on the item, once per pull request. */
  async function deliverOnce(
    wi: string,
    repo: string,
    pr: number,
    actor: EngineActor,
  ): Promise<void> {
    const ref = `${repo}#${pr}`;
    const store = openWorkStore(harnessDir, { now });
    const read = store.get(wi);
    if ("ok" in read || read.revision === undefined) return;
    if ((read.revision.delivered ?? []).some((d) => d.kind === "pr" && d.ref === ref)) return;
    await store.deliver(wi, { kind: "pr", ref }, actor);
  }

  async function reconcile(
    wi: string,
    n: number,
    opts: { actor: EngineActor; signal?: AbortSignal },
  ): Promise<FoldedAttempt | undefined> {
    assertHarnessCwd(harnessDir);
    const attempt = readAttempts(harnessDir)
      .get(wi)
      ?.find((a) => a.attempt === n);
    if (attempt === undefined) return undefined;
    const ws = readWorkspaces(harnessDir).get(wi);
    const binding = ws === undefined ? undefined : bindingNamed(ws.binding);
    if (binding === undefined || attempt.branch === undefined) return attempt;
    if (attempt.state === "done" && attempt.pr !== undefined) {
      await deliverOnce(wi, binding.repo, attempt.pr, opts.actor);
      return attempt;
    }
    if (attempt.state !== "unknown") return attempt;
    const host = await hostFor(binding, opts.signal);
    if ("ok" in host) return attempt;
    const branch = attempt.branch;
    const found = await withPullsCall(
      {
        apiBase: host.api,
        token: host.token,
        timeoutMs: apiTimeoutMs,
        allowLoopback: host.apiLoopback,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
      (c) => findPullByHead(c, host.repo, branch),
    ).catch(() => undefined);
    if (found === undefined || !found.ok) return attempt;
    const settle = async (fields: Partial<PublishLine>): Promise<FoldedAttempt> => {
      const next: PublishLine = {
        ...attempt,
        ...fields,
        at: stamp(),
        by: opts.actor.by,
        via: opts.actor.via,
      };
      await appendAttempt(harnessDir, next);
      return next;
    };
    // One branch per item, so a pull request from it that no earlier attempt opened is this
    // attempt's. One an earlier attempt opened is this attempt's only while it is open at the
    // commit this attempt pushed.
    const { pull } = found;
    const earlier =
      pull !== undefined &&
      (readAttempts(harnessDir).get(wi) ?? []).some((a) => a.attempt < n && a.pr === pull.number);
    const landed =
      pull !== undefined &&
      (!earlier ||
        (pull.state === "open" && pull.headSha === (attempt.pushedSha ?? attempt.headSha)));
    if (pull !== undefined && landed) {
      const done = await settle({ state: "done", pr: pull.number });
      await deliverOnce(wi, binding.repo, pull.number, opts.actor);
      return done;
    }
    return settle({ state: "not-done" });
  }

  async function close(
    wi: string,
    opts: { actor: EngineActor; signal?: AbortSignal },
  ): Promise<{ closed: boolean; wip: boolean }> {
    assertHarnessCwd(harnessDir);
    const ws = readWorkspaces(harnessDir).get(wi);
    if (ws === undefined || ws.state !== "open") return { closed: false, wip: false };
    const hold = await takePublishHold(harnessDir, wi, now, deps.probe);
    if (hold === undefined) return { closed: false, wip: false };
    try {
      // The records name the directory, so a binding the spec dropped is closed too.
      const name = worktreeNameOf(ws.branch);
      const bindingDir = bindingDirOf(ws.binding);
      const made = ensureDirContained(harnessDir, join(bindingDir, "wt"), { mode: 0o700 });
      if (!made.ok) return { closed: false, wip: false };
      const paths: Paths = {
        repoDir: join(made.real, "..", "repo"),
        worktree: join(made.real, name),
        worktreeRel: join(bindingDir, "wt", name),
      };
      let wip = false;
      if (worktreeReady(paths)) {
        await settleRebase(paths);
        if (!(await isClean(paths))) {
          await commitAll(paths, "crewhaus: work in progress\n");
          wip = true;
          if (!(await onBranch(paths, ws.branch))) {
            const head = await sha(at(paths), "HEAD");
            if (head !== undefined) {
              await step({
                repoDir: paths.repoDir,
                args: ["update-ref", `refs/crewhaus/wip/${name}`, head],
              });
            }
          }
        }
        await step({
          repoDir: paths.repoDir,
          args: ["worktree", "remove", "--force", paths.worktree],
        });
      }
      removeContainedDir(harnessDir, paths.worktreeRel);
      if (existsSync(join(paths.repoDir, "HEAD"))) {
        await step({ repoDir: paths.repoDir, args: ["worktree", "prune"] });
      }
      await line(ws, wi, opts.actor, {
        state: "closed",
        event: "closed",
        ...(ws.baseSha !== undefined ? { baseSha: ws.baseSha } : {}),
        wip,
      });
      return { closed: true, wip };
    } finally {
      await hold.release();
    }
  }

  return { open, check, publish, reconcile, settle, close };
}
