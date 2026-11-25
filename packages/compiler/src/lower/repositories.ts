import type { IrIntent, IrRepository } from "@crewhaus/ir";
import { REPOSITORY_DEFAULTS } from "@crewhaus/spec";
import { parseDurationToMs } from "./schedule";

type SpecRepository = {
  readonly host: "github";
  readonly repo: string;
  readonly base?: string | undefined;
  readonly branch_prefix?: string | undefined;
  readonly checks?: readonly (readonly string[])[] | undefined;
  readonly check_timeout?: string | undefined;
  readonly check_image?: string | undefined;
  readonly pull_requests?:
    | {
        readonly draft?: boolean | undefined;
        readonly max_files?: number | undefined;
        readonly max_lines?: number | undefined;
        readonly revalidate?: "rebase" | "refresh" | undefined;
        readonly require?: readonly ("checks" | "acceptance")[] | undefined;
      }
    | undefined;
  readonly server?:
    | { readonly api?: string | undefined; readonly git?: string | undefined }
    | undefined;
  readonly allow_private_target?: boolean | undefined;
};

type SpecIntent = {
  readonly purpose: string;
  readonly serves?: readonly string[] | undefined;
  readonly outcomes?: readonly string[] | undefined;
  readonly excludes?: readonly string[] | undefined;
};

function originOf(raw: string): string {
  return new URL(raw).origin;
}

/** A binding with its defaults resolved. `require` is in a fixed order, so it has one spelling. */
function lowerRepository(name: string, r: SpecRepository): IrRepository {
  const checks = (r.checks ?? []).map((argv) => [...argv]);
  const required =
    r.pull_requests?.require ??
    (checks.length > 0 ? (["checks", "acceptance"] as const) : (["acceptance"] as const));
  return {
    name,
    host: r.host,
    repo: r.repo,
    base: r.base ?? REPOSITORY_DEFAULTS.base,
    branchPrefix: r.branch_prefix ?? REPOSITORY_DEFAULTS.branchPrefix,
    checks,
    checkTimeoutMs:
      r.check_timeout === undefined
        ? REPOSITORY_DEFAULTS.checkTimeoutMs
        : parseDurationToMs(r.check_timeout),
    ...(r.check_image !== undefined ? { checkImage: r.check_image } : {}),
    pullRequests: {
      draft: r.pull_requests?.draft ?? true,
      maxFiles: r.pull_requests?.max_files ?? REPOSITORY_DEFAULTS.maxFiles,
      maxLines: r.pull_requests?.max_lines ?? REPOSITORY_DEFAULTS.maxLines,
      revalidate: r.pull_requests?.revalidate ?? "rebase",
      require: (["checks", "acceptance"] as const).filter((item) => required.includes(item)),
    },
    server: {
      api: originOf(r.server?.api ?? REPOSITORY_DEFAULTS.api),
      git: originOf(r.server?.git ?? REPOSITORY_DEFAULTS.git),
    },
    ...(r.allow_private_target === true ? { allowPrivateTarget: true as const } : {}),
  };
}

/**
 * Lower `repositories:` (#514), sorted by binding name, and beside it the declared `intent:`,
 * which only the workspace tools' acceptance judge reads. Returns `{}` when the spec declares
 * no `repositories:`, so a spec without it, and one that declares `intent:` alone, lowers to
 * the same IR and compiles to the same bytes.
 */
export function lowerRepositories(spec: {
  readonly repositories?: Readonly<Record<string, SpecRepository>> | undefined;
  readonly intent?: SpecIntent | undefined;
}): { readonly repositories?: readonly IrRepository[]; readonly intent?: IrIntent } {
  if (spec.repositories === undefined) return {};
  const names = Object.keys(spec.repositories).sort();
  if (names.length === 0) return {};
  const { intent } = spec;
  return {
    repositories: names.map((name) =>
      lowerRepository(
        name,
        (spec.repositories as Record<string, SpecRepository>)[name] as SpecRepository,
      ),
    ),
    ...(intent !== undefined
      ? {
          intent: {
            purpose: intent.purpose,
            ...(intent.serves !== undefined ? { serves: [...intent.serves] } : {}),
            ...(intent.outcomes !== undefined ? { outcomes: [...intent.outcomes] } : {}),
            ...(intent.excludes !== undefined ? { excludes: [...intent.excludes] } : {}),
          },
        }
      : {}),
  };
}
