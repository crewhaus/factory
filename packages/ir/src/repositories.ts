/**
 * `repositories:` and `intent:` as the IR carries them (#514): where a harness may deliver
 * work as pull requests, what a change must pass first, and, for the acceptance judge alone,
 * what the harness is for. Defaults are resolved at lower time and the bindings are sorted by
 * name, so a bundle does not depend on the order a spec lists them in. Both keys are absent
 * from the IR of a spec that declares no `repositories:`.
 */

/** One repository binding. */
export type IrRepository = {
  readonly name: string;
  readonly host: "github";
  /** `owner/name`. */
  readonly repo: string;
  readonly base: string;
  readonly branchPrefix: string;
  /** Each check is a program and its arguments; none declared is an empty list. */
  readonly checks: readonly (readonly string[])[];
  readonly checkTimeoutMs: number;
  readonly checkImage?: string;
  readonly pullRequests: {
    readonly draft: boolean;
    readonly maxFiles: number;
    readonly maxLines: number;
    readonly revalidate: "rebase" | "refresh";
    readonly require: readonly ("checks" | "acceptance")[];
  };
  readonly server: { readonly api: string; readonly git: string };
  /** Admits a loopback server for this binding. Carried only when true. */
  readonly allowPrivateTarget?: true;
};

/** What the harness is for, in its owner's words: the acceptance judge's input, and nothing else. */
export type IrIntent = {
  readonly purpose: string;
  readonly serves?: readonly string[];
  readonly outcomes?: readonly string[];
  readonly excludes?: readonly string[];
};
