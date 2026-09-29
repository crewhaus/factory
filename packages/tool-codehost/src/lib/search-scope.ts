/**
 * Which repositories a GitHub search reaches, said where a permission rule
 * can read it.
 *
 * GitHub's search takes its scope from qualifiers inside the query text —
 * `repo:acme/widget`, `org:acme`, `user:acme` — and ignores the tools'
 * `owner` and `repo` fields. A permission rule reads those fields
 * (`SearchCode`'s `operativeArgs` are `owner/repo`), so a scope written only
 * in the query was invisible to it: `alwaysDeny SearchCode(acme/secret)` was
 * dodged by `{ query: "password repo:acme/secret" }` (C004).
 *
 * So the two are made to agree. A scope qualifier in the query must be
 * covered by the fields — the same repository, or the whole owner — or the
 * search is refused with the fields to add. Fields given without a qualifier
 * are written into the query, so they scope the search they claim to. An
 * owner with no repository needs the query to say whether it is an `org:` or
 * a `user:`, because the two are different qualifiers and guessing one would
 * search something the caller did not ask for.
 *
 * Deliberately conservative: a qualifier behind `NOT`, or inside
 * parentheses, still counts as a scope to be covered. Only a leading `-`
 * (GitHub's exclusion) is left alone, because it narrows, and so is text
 * inside a double-quoted phrase, which GitHub searches for as written
 * (`"curl -u user:$TOKEN"` is not a `user:` scope). A query whose quotes do
 * not pair up is read both ways, so a stray quote cannot hide a qualifier.
 */

/** One scope the query names. `repo` is absent for `org:` and `user:`. */
type QueryScope = {
  readonly qualifier: "repo" | "org" | "user";
  readonly owner: string;
  readonly repo?: string;
};

const SCOPE_TOKEN = /^(repo|org|user):(.+)$/i;

/**
 * The query's terms, split at whitespace outside double quotes. A quoted
 * section right after `repo:`, `org:` or `user:` is that qualifier's value
 * and stays in its term (`repo:"acme/widget"`); any other quoted section is
 * a phrase or another qualifier's value, is dropped, and ends the term it
 * interrupts, so `"x"repo:a/b` still yields `repo:a/b`. `null` when the
 * quotes do not pair up.
 */
function quotedTerms(query: string): string[] | null {
  const terms: string[] = [];
  let term = "";
  const flush = (): void => {
    if (term !== "") terms.push(term);
    term = "";
  };
  let i = 0;
  while (i < query.length) {
    const ch = query.charAt(i);
    if (ch === '"') {
      const close = query.indexOf('"', i + 1);
      if (close < 0) return null;
      const section = query.slice(i, close + 1);
      if (SCOPE_PREFIX.test(term)) term += section;
      else flush();
      i = close + 1;
      continue;
    }
    if (/\s/.test(ch)) flush();
    else term += ch;
    i++;
  }
  flush();
  return terms;
}

/** A term that so far is a scope qualifier waiting for its value. */
const SCOPE_PREFIX = /^[(-]*(repo|org|user):$/i;

/** The scope qualifiers a GitHub query carries, exclusions and quoted phrases left out. */
export function queryScopes(query: string): QueryScope[] {
  const terms = quotedTerms(query);
  if (terms === null) {
    // Unpaired quotes: whether the host reads a phrase or not, a qualifier
    // either way is a scope.
    const seen = new Set<string>();
    return [
      ...scopesOf(query.split(/\s+/)),
      ...scopesOf(query.replaceAll('"', " ").split(/\s+/)),
    ].filter((scope) => {
      const key = JSON.stringify(scope);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return scopesOf(terms);
}

function scopesOf(terms: ReadonlyArray<string>): QueryScope[] {
  const out: QueryScope[] = [];
  for (const raw of terms) {
    // `(repo:a/b` and `repo:a/b)` inside a boolean group are still scopes.
    const token = raw.replace(/^\(+/, "").replace(/\)+$/, "");
    if (token.startsWith("-")) continue;
    const m = token.match(SCOPE_TOKEN);
    if (m === null) continue;
    const qualifier = (m[1] as string).toLowerCase() as QueryScope["qualifier"];
    const value = (m[2] as string).replace(/^"(.*)"$/, "$1");
    if (qualifier === "repo") {
      const slash = value.indexOf("/");
      out.push(
        slash < 0
          ? { qualifier, owner: value, repo: "" }
          : { qualifier, owner: value.slice(0, slash), repo: value.slice(slash + 1) },
      );
    } else {
      out.push({ qualifier, owner: value });
    }
  }
  return out;
}

export type ScopedQuery =
  | { readonly ok: true; readonly q: string }
  | { readonly ok: false; readonly message: string };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A caller's value inside a refusal: quoted, escaped, and bounded. */
const shown = (value: string): string => JSON.stringify(value.slice(0, 100));

/** A GitHub owner or repository name: the characters GitHub allows, and no traversal. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const nameProblem = (field: string, value: string): string | undefined =>
  !NAME.test(value) || value === "." || value === ".."
    ? `${field} ${shown(value)} is not a GitHub name — letters, digits, ".", "_" and "-" only`
    : undefined;

/**
 * The `q` to send for a GitHub search whose declared scope is
 * `owner`/`repo`, or the reason the call is refused. `tool` names the tool
 * in the message.
 */
export function githubSearchQuery(
  tool: string,
  query: string,
  owner: string | undefined,
  repo: string | undefined,
): ScopedQuery {
  if (repo !== undefined && owner === undefined) {
    return {
      ok: false,
      message: `${tool}: repo needs owner — a repository is searched as owner/repo. Nothing was searched.`,
    };
  }
  // Checked before either is written into the query: a space in one would
  // add a qualifier of its own.
  for (const [field, value] of [
    ["owner", owner],
    ["repo", repo],
  ] as const) {
    const problem = value === undefined ? undefined : nameProblem(field, value);
    if (problem !== undefined)
      return { ok: false, message: `${tool}: ${problem}. Nothing was searched.` };
  }
  const scopes = queryScopes(query);
  const fields =
    owner === undefined
      ? "no owner"
      : repo === undefined
        ? `owner ${shown(owner)}`
        : `owner ${shown(owner)} and repo ${shown(repo)}`;
  for (const scope of scopes) {
    const written = shown(
      scope.qualifier === "repo"
        ? `repo:${scope.owner}/${scope.repo}`
        : `${scope.qualifier}:${scope.owner}`,
    );
    // A qualifier that names no GitHub account or repository cannot be
    // named in the fields either: say so rather than suggest it.
    const unnamed =
      nameProblem("owner", scope.owner) ??
      (scope.qualifier === "repo" ? nameProblem("repo", scope.repo ?? "") : undefined);
    if (unnamed !== undefined) {
      return {
        ok: false,
        message: `${tool}: the query's qualifier ${written} does not name a GitHub ${scope.qualifier === "repo" ? "repository as owner/repo" : "account"} (${unnamed}). Remove it, or put the text in double quotes to search for it as written. Nothing was searched.`,
      };
    }
    const covered =
      owner !== undefined &&
      same(scope.owner, owner) &&
      (repo === undefined || (scope.qualifier === "repo" && same(scope.repo ?? "", repo)));
    if (!covered) {
      const want =
        scope.qualifier === "repo" && scope.repo !== ""
          ? `owner ${shown(scope.owner)} and repo ${shown(scope.repo ?? "")}`
          : `owner ${shown(scope.owner)} and no repo`;
      return {
        ok: false,
        message: `${tool}: the query searches ${written}, which the call's owner and repo do not cover (it names ${fields}). A permission rule reads owner and repo, so name the same scope there — ${want} — and keep the qualifier in the query. Nothing was searched.`,
      };
    }
  }
  if (owner === undefined || scopes.length > 0) return { ok: true, q: query };
  if (repo !== undefined) return { ok: true, q: `${query} repo:${owner}/${repo}` };
  return {
    ok: false,
    message: `${tool}: owner ${shown(owner)} without a repo searches that whole account, and GitHub needs to be told whether it is an organization or a user — add org:${owner} or user:${owner} to the query. Nothing was searched.`,
  };
}
