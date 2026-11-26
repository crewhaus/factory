import { z } from "zod";
import type { Spec } from "../index";
import type { SpecAddIssue } from "./delta-090";

/**
 * `repositories:` — the repositories a harness may deliver work to as pull requests, how a
 * change is checked first, and what a pull request needs before it opens (#514, #516). Each
 * binding is read by the workspace tools alone (`@crewhaus/tool-work`); a spec that lists
 * none of them gets a warning that the block does nothing. Only its owner changes it: which
 * repository is written and the bar a change must pass are never the optimizer's, and the
 * spec editor asks for the typed confirmation (`packages/spec-patch/src/owner-keys.ts`).
 *
 * A check is an argv, never a shell line. `server` names another code host's API and git
 * origins. `allow_private_target` admits a loopback origin for that binding, and only a
 * loopback one; no environment variable does.
 */
export const REPOSITORY_BINDING_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** `owner/name`, as GitHub spells a repository. */
export const REPOSITORY_NAME_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** What a minted branch starts with: one or more plain path segments and a `/`. */
export const BRANCH_PREFIX_RE = /^[a-z0-9][a-z0-9/-]{0,30}\/$/;
/** A container image the sandbox accepts: `repository[:tag][@digest]`. */
const IMAGE_RE =
  /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** The programs that read their arguments as a command line. A check names the program itself. */
const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
]);

const CHECKS_MAX = 10;
const CHECK_WORDS_MAX = 32;
const CHECK_WORD_CHARS = 512;
const CHECK_TIMEOUT_MAX_MS = 60 * 60 * 1000;
const BINDINGS_MAX = 8;

export const REPOSITORY_DEFAULTS = Object.freeze({
  base: "main",
  branchPrefix: "crewhaus/",
  checkTimeoutMs: 10 * 60 * 1000,
  maxFiles: 20,
  maxLines: 800,
  api: "https://api.github.com",
  git: "https://github.com",
} as const);

/** A branch name git accepts and no tool reads as an option. */
function isBranchName(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function durationMs(value: string): number | undefined {
  const m = /^(\d{1,9})(ms|s|m|h|d)$/.exec(value);
  if (m === null) return undefined;
  return Number.parseInt(m[1] as string, 10) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

const checkWord = z
  .string()
  .min(1, "a check's words are not empty")
  .max(CHECK_WORD_CHARS, `a check's word is at most ${CHECK_WORD_CHARS} characters`)
  .refine((w) => !/[\0\n\r]/.test(w), "a check's word holds no line break");

const checkArgv = z
  .array(checkWord)
  .min(1, "a check is a program and its arguments")
  .max(CHECK_WORDS_MAX, `a check has at most ${CHECK_WORDS_MAX} words`)
  .refine((argv) => {
    const program = argv[0] ?? "";
    return (
      /^[A-Za-z0-9._][A-Za-z0-9._+/-]*$/.test(program) &&
      !program.split("/").includes("..") &&
      !program.startsWith("/")
    );
  }, "a check starts with a program name or a relative path to one")
  .refine(
    (argv) => !SHELLS.has((argv[0]?.split("/").at(-1) ?? "").toLowerCase()),
    "a check is an argv, never a shell: name the program itself, and put each argument in its own item",
  );

const originText = z
  .string()
  .max(300)
  .refine((raw) => originOf(raw) !== undefined, {
    message: "an origin is written as https://host[:port], with no path, user or query",
  });

/** The origin a text names, or `undefined` when it is not one. */
function originOf(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  return url.pathname === "/" || url.pathname === "" ? url : undefined;
}

const requireItem = z.enum(["checks", "acceptance"]);

const pullRequests = z
  .object({
    draft: z.boolean().optional().describe("open pull requests as drafts (default true)"),
    max_files: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("a change past this many files waits for a person (default 20)"),
    max_lines: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe("a change past this many changed lines waits for a person (default 800)"),
    revalidate: z
      .enum(["rebase", "refresh"])
      .optional()
      .describe(
        "what a moved base does before publishing: rebase the change (default), or ask for it again on the new base",
      ),
    require: z
      .array(requireItem)
      .min(1, "pull_requests.require names checks, acceptance or both")
      .max(2)
      .refine((list) => new Set(list).size === list.length, "list each requirement once")
      .optional()
      .describe(
        "what must pass before a pull request opens (default: checks when declared, and acceptance)",
      ),
  })
  .strict();

const binding = z
  .object({
    host: z.literal("github"),
    repo: z.string().regex(REPOSITORY_NAME_RE, "repo is owner/name"),
    base: z
      .string()
      .refine(isBranchName, "base is a branch name")
      .optional()
      .describe("the branch a change starts from and is proposed to (default main)"),
    branch_prefix: z
      .string()
      .regex(BRANCH_PREFIX_RE, "branch_prefix is lower-case letters, digits, - and /, ending in /")
      .refine((p) => !p.includes("//"), "branch_prefix has no empty part")
      .optional()
      .describe("what the branches this harness makes start with (default crewhaus/)"),
    checks: z
      .array(checkArgv)
      .min(1)
      .max(CHECKS_MAX, `checks lists at most ${CHECKS_MAX} commands`)
      .optional()
      .describe(
        "commands a change must pass, each a program and its arguments, run in the sandbox",
      ),
    check_timeout: z
      .string()
      .refine((v) => {
        const ms = durationMs(v);
        return ms !== undefined && ms >= 1000 && ms <= CHECK_TIMEOUT_MAX_MS;
      }, 'check_timeout is a duration from "1s" to "1h", such as "10m"')
      .optional()
      .describe("how long one check may run (default 10m)"),
    check_image: z
      .string()
      .regex(IMAGE_RE, "check_image is a container image, such as oven/bun:1")
      .optional()
      .describe("the container image the checks run in"),
    pull_requests: pullRequests.optional(),
    server: z
      .object({ api: originText.optional(), git: originText.optional() })
      .strict()
      .optional()
      .describe("another code host's API and git origins (default github.com)"),
    allow_private_target: z
      .boolean()
      .optional()
      .describe("admit a loopback server for this binding"),
  })
  .strict();

export const repositoriesBlock = z
  .record(
    z.string().regex(REPOSITORY_BINDING_RE, "a binding is a-z, 0-9 and -, at most 40"),
    binding,
  )
  .refine((r) => Object.keys(r).length >= 1, "repositories names at least one binding")
  .refine(
    (r) => Object.keys(r).length <= BINDINGS_MAX,
    `repositories names at most ${BINDINGS_MAX} bindings`,
  )
  .optional()
  .describe("the repositories this harness may deliver work to; only the owner edits it");

/** A host as a URL's `hostname` spells it: `[::1]` keeps its brackets. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === "[::1]"
  );
}

/** A literal private, link-local, shared or unspecified address. Names are judged when they resolve. */
function isPrivateHostname(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::\]|::ffff:)/i.test(hostname);
}

/**
 * The cross-field checks: a private origin that is not loopback is never reachable, a
 * loopback one needs the binding's `allow_private_target`, plain `http:` is for an admitted
 * loopback origin only, and `pull_requests.require` cannot ask for checks nobody declared.
 * No message repeats an origin's text.
 */
export function repositoriesIssues(data: Spec, custom: SpecAddIssue): void {
  if (!("repositories" in data) || data.repositories === undefined) return;
  for (const [name, b] of Object.entries(data.repositories)) {
    for (const key of ["api", "git"] as const) {
      const raw = b.server?.[key];
      const url = raw === undefined ? undefined : originOf(raw);
      if (url === undefined) continue;
      const at = ["repositories", name, "server", key];
      if (isLoopbackHostname(url.hostname)) {
        if (b.allow_private_target !== true) {
          custom(
            at,
            `repositories.${name}.server.${key} is a loopback address: set repositories.${name}.allow_private_target: true to reach it, or remove server.`,
          );
        }
        continue;
      }
      if (isPrivateHostname(url.hostname)) {
        custom(
          at,
          `repositories.${name}.server.${key} is a private address, which a harness never reaches: use the code host's public address.`,
        );
        continue;
      }
      if (url.protocol === "http:") {
        custom(
          at,
          `repositories.${name}.server.${key} must be https: only a loopback server with allow_private_target may use http.`,
        );
      }
    }
    if (b.pull_requests?.require?.includes("checks") === true && (b.checks ?? []).length === 0) {
      custom(
        ["repositories", name, "pull_requests", "require"],
        `repositories.${name}.pull_requests.require asks for checks, but no checks are declared: add repositories.${name}.checks, or require acceptance alone.`,
      );
    }
  }
}
