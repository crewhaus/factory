/**
 * Why a run failed, as a key that groups runs failing for the same reason. Built from
 * names only: a provider, an env name, a failure class, ids and digests; never a value
 * and never a message.
 *
 * | Cause | Key | Groups across harnesses |
 * |---|---|---|
 * | credential | `credential:<provider>:<envName>@<sourceDigest>` (class `auth`/`billing`) | yes, when the env file is one file |
 * | provider-limit | `provider-limit:<provider>:rate_limit` | yes, runs within an hour of each other |
 * | deployment | `deployment:<dep_…>` | yes |
 * | budget | `budget:<hrn>:total` (class `crewhaus_budget`) | no |
 * | spec | `spec:<hrn>:<specHash or unknown>` (class `spec`) | no |
 * | message | `message:<hrn>:<class>:<signature>` (a failure-message cluster) | no |
 * | failure-class | `failure-class:<hrn>:<class>` | no |
 *
 * The credential's source is the env file that supplies the name in the harness's env
 * chain: `sourceDigest` is 16 hex of sha256 of its real path, so harnesses that read one
 * shared file share one cause. A name the process environment supplies, or no file at
 * all, keys per harness (`@hrn_…`). The provider and its credential names come from the
 * spec's model, through the same helpers the preflight uses.
 */
import { closeSync, readSync } from "node:fs";
import type { CauseKind } from "@crewhaus/control-contract";
import { extractSpecModel, modelCredentialGroups, selectedProvider } from "@crewhaus/preflight";
import { openForReadFd } from "@crewhaus/tool-safety/fs";
import { digestPrefix } from "./ids";
import type { HarnessFacts, RunFact } from "./types";

/** What a harness's spec and env chain say about the credential its runs use. */
export type CredentialFacts = {
  readonly provider: string;
  readonly envName: string;
  /** `@<16 hex>` of the supplying file, or `@<hrn>` when the name is not from a file. */
  readonly source: string;
};

/** Everything `causeOf` needs besides the row: names and digests only. */
export type CauseFacts = {
  readonly harness: string;
  readonly credential: CredentialFacts;
  /** `<session>|<class>` → the failure-message cluster's signature. */
  readonly signatures: ReadonlyMap<string, string>;
};

export type Cause = {
  readonly id: string;
  readonly kind: CauseKind;
  /** The item kind the group of this cause is. */
  readonly itemKind: "credential" | "provider-limit" | "budget" | "spec" | "run-failures";
  readonly label: string;
  /** The title params: names and classes only. */
  readonly params: Readonly<Record<string, string>>;
  readonly titleTemplate: string;
};

const DEPLOYMENT_RE = /^dep_[0-9a-hjkmnp-tv-z]{26}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** A name as a key segment: itself when it is one, else its digest. */
function segment(value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  return SAFE_NAME_RE.test(value) ? value : `h${digestPrefix(value, 12)}`;
}

/** Why a failed row failed, as a group key. Pure. */
export function causeOf(row: RunFact, facts: CauseFacts): Cause {
  const cls = segment(row.failureClass, "unknown");
  const hrn = facts.harness;
  const { provider, envName, source } = facts.credential;
  if (cls === "auth" || cls === "billing") {
    return {
      id: `credential:${provider}:${envName}${source}`,
      kind: "credential",
      itemKind: "credential",
      label: `${provider} ${envName}`,
      params: { provider, envName },
      titleTemplate: "credential.failing",
    };
  }
  if (cls === "rate_limit") {
    return {
      id: `provider-limit:${provider}:rate_limit`,
      kind: "provider-limit",
      itemKind: "provider-limit",
      label: provider,
      params: { provider },
      titleTemplate: "provider-limit.hit",
    };
  }
  if (row.deployment !== undefined && DEPLOYMENT_RE.test(row.deployment)) {
    return {
      id: `deployment:${row.deployment}`,
      kind: "deployment",
      itemKind: "run-failures",
      label: row.deployment,
      params: { deployment: row.deployment, class: cls },
      titleTemplate: "deployment.failing",
    };
  }
  if (cls === "crewhaus_budget") {
    return {
      id: `budget:${hrn}:total`,
      kind: "budget",
      itemKind: "budget",
      label: "budget",
      params: { period: "total" },
      titleTemplate: "budget.exhausted",
    };
  }
  if (cls === "spec") {
    const spec = segment(row.specHash, "unknown");
    return {
      id: `spec:${hrn}:${spec}`,
      kind: "spec",
      itemKind: "spec",
      label: "spec",
      params: {},
      titleTemplate: "spec.failing",
    };
  }
  const signature =
    row.session === undefined ? undefined : facts.signatures.get(`${row.session}|${cls}`);
  if (signature !== undefined) {
    return {
      id: `message:${hrn}:${cls}:${signature}`,
      kind: "message",
      itemKind: "run-failures",
      label: cls,
      params: { class: cls },
      titleTemplate: "run-failures.message",
    };
  }
  return {
    id: `failure-class:${hrn}:${cls}`,
    kind: "failure-class",
    itemKind: "run-failures",
    label: cls,
    params: { class: cls },
    titleTemplate: "run-failures.class",
  };
}

const SPEC_FILES = ["crewhaus.yaml", "crewhaus.yml"] as const;
const SPEC_MAX_BYTES = 512 * 1024;

/** The harness's spec text, read contained and capped; `undefined` when there is none. */
function specText(dir: string): string | undefined {
  for (const name of SPEC_FILES) {
    const opened = openForReadFd(dir, name, { followLeafSymlink: true });
    if (!opened.ok) continue;
    try {
      const buffer = Buffer.alloc(SPEC_MAX_BYTES);
      let filled = 0;
      while (filled < buffer.length) {
        const n = readSync(opened.fd, buffer, filled, buffer.length - filled, filled);
        if (n === 0) break;
        filled += n;
      }
      return buffer.subarray(0, filled).toString("utf8");
    } catch {
      return undefined;
    } finally {
      closeSync(opened.fd);
    }
  }
  return undefined;
}

/**
 * The credential a harness's runs use: the spec model's provider, the first of its
 * credential names the chain or the process supplies, and where that name comes from.
 */
export function credentialFactsOf(
  dir: string,
  harness: string,
  facts: HarnessFacts,
): CredentialFacts {
  const yaml = specText(dir);
  const model = yaml === undefined ? undefined : extractSpecModel(yaml);
  const provider = segment(model === undefined ? undefined : selectedProvider(model), "unknown");
  const names = model === undefined ? [] : (modelCredentialGroups(model)[0] ?? []);
  for (const name of names) {
    const source = facts.envNameSource(dir, name);
    if (source === undefined) continue;
    return {
      provider,
      envName: segment(name, "unknown"),
      source: source === "process" ? `@${harness}` : `@${digestPrefix(source.file, 16)}`,
    };
  }
  return { provider, envName: segment(names[0], "none"), source: `@${harness}` };
}
