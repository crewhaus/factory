/**
 * Thredz wiki-space client — the third provisioner, and the one whose whole
 * job is a single find-or-create.
 *
 * WHY THIS EXISTS. A harness that carries a `thredz.space` in its spec cannot
 * boot until that space exists: the daemon's first wiki write 404s otherwise,
 * and the operator is left reading a stack trace to learn they were meant to
 * click "New space" in a web UI first. `crewhaus services setup` closes that
 * gap by provisioning the space ahead of the daemon, from the same operator
 * key that already appears in `PROVISIONING_CREDENTIALS`.
 *
 * WHY IT IS FIDDLIER THAN IT LOOKS. Three properties of the Thredz wiki API
 * shape almost every decision below:
 *
 *  1. `POST /wiki/spaces` is NOT idempotent, and `/wiki/*` has no
 *     `Idempotency-Key` support (that header is honoured only on the goals and
 *     messages routes). Retry safety is therefore entirely the client's job —
 *     hence list-first, then create, then tolerate a 409.
 *  2. The list is scoped to what the CALLING key may see: every `shared` space
 *     on the account, plus `individual` spaces whose `ownerKeyId` is this key.
 *     A clean list therefore does NOT prove a slug is free — another key's
 *     individual space with the same slug is invisible to us and still
 *     collides on create. This is why the 409 branch is a real code path and
 *     not defensive padding.
 *  3. A key may own exactly one individual space, forever. That cap is not a
 *     quota that clears; it is a modelling rule, so its 409 is a hard failure
 *     with a different remedy than a slug collision.
 *
 * Everything network goes through `requestJson`, and every provider failure
 * comes back as a `ServiceSetupError` carrying the wire status plus a `fix:`
 * line the operator can act on without opening the Thredz dashboard.
 */
import type { JsonResponse } from "./http";
import { asRecord, readString, requestJson } from "./http";
import type { ServiceDeps } from "./types";
import { ServiceSetupError } from "./types";

/**
 * Default API root.
 *
 * This is the hard-coded client default in the published `thredz-mcp` server,
 * not a documented server URL — Thredz publishes no stable base-path contract,
 * so treat it as "what every shipped client points at today" and let callers
 * override it via `ThredzDeps.apiBase` (self-hosted instances, staging, and
 * every test in this package do exactly that).
 */
export const THREDZ_API_BASE = "https://thredz.crewhaus.ai/api";

/**
 * The Combining Diacritical Marks block, which is what "strip accents" means
 * once a string has been decomposed with NFD.
 *
 * The range is kept deliberately narrow to mirror the server: `\p{Mn}` would
 * additionally strip non-Latin marks, which the server instead maps to `-`.
 */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: matching bare combining marks after NFD is exactly the intent — this class strips accents, it does not split graphemes
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * The single operator credential this module needs.
 *
 * Keys are minted in the Thredz dashboard (they cannot be created over the
 * API) and look like `thredz_` followed by 48 hex characters. The key travels
 * as `Authorization: Bearer <key>` and is never written into a harness spec —
 * it is a provisioning credential, not a runtime one.
 */
export type ThredzAuth = { readonly apiKey: string };

/**
 * Injected seams, plus the one Thredz-specific knob. `apiBase` exists so the
 * tests (and self-hosted deployments) never touch the public host; a trailing
 * slash is tolerated and stripped.
 */
export type ThredzDeps = ServiceDeps & { readonly apiBase?: string };

/**
 * The two space types, exactly as the server enumerates them.
 *
 * `shared` is readable by every wiki-enabled key on the account; `individual`
 * is readable only by its `ownerKeyId`. The distinction is a visibility
 * boundary, which is why this client refuses to silently substitute one for
 * the other (see `ensureSpace`).
 */
export type SpaceType = "shared" | "individual";

/**
 * The subset of a serialized space this package needs.
 *
 * The wire object also carries `accountId`, `description`, `createdByKeyId`,
 * `createdAt` and `updatedAt`; they are dropped here because nothing in setup
 * branches on them, and a narrower type is a narrower thing to keep in sync.
 * Note the identifier is `id` — not `_id`, despite the document store beneath.
 */
export type WikiSpace = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly type: SpaceType;
  /** Owning key for an `individual` space; `null` for a `shared` one. */
  readonly ownerKeyId: string | null;
  readonly articleCount: number;
};

/**
 * A whole `GET /wiki/spaces` answer: the visible spaces plus the account's
 * usage and plan caps.
 *
 * `limits` fields are `number | null` because a plan may express "no ceiling"
 * by omitting the field entirely; a missing limit is deliberately NOT reported
 * as `0`, which would read as "none allowed" and is the opposite of the truth.
 */
export type SpaceInventory = {
  readonly spaces: readonly WikiSpace[];
  readonly usage: { readonly shared: number; readonly individual: number };
  readonly limits: {
    readonly shared: number | null;
    readonly individual: number | null;
    readonly individualPerKey: number | null;
  };
};

/**
 * What `createSpace` and `ensureSpace` accept. `name` is the only required
 * field; kept local (not exported) so the public surface stays the four
 * functions plus the four data types.
 */
type SpaceInput = {
  readonly name: string;
  /** Omit to let the server derive it from `name` — `slugifySpaceName` predicts that. */
  readonly slug?: string;
  /** Defaults to `"shared"` server-side. */
  readonly type?: SpaceType;
  /** Trimmed and truncated to 500 characters server-side. */
  readonly description?: string;
};

/**
 * PURE. Mirrors the server's slug normalisation exactly, so a caller can
 * predict the slug a `name` will produce and pre-check the list against it
 * before spending a write.
 *
 * The server's steps, in order: lowercase, strip accents, map runs of
 * non-`[a-z0-9/]` to a single `-`, trim leading and trailing `-`, then replace
 * `/` with `-`.
 *
 * That ORDER carries two quirks worth preserving rather than "fixing", because
 * a client that tidied them up would predict the wrong slug and turn a clean
 * adopt into a surprise 409:
 *  - the trim runs BEFORE slashes are mapped, so `"/ops/"` normalises to
 *    `"-ops-"` with the dashes intact;
 *  - slash mapping happens after run-collapsing, so `"a//b"` keeps both
 *    dashes and becomes `"a--b"`.
 *
 * Both quirks also make the function non-idempotent for names containing
 * slashes (`"a / b"` → `"a---b"` → `"a-b"`), so slugify a NAME once and carry
 * the result; never re-slugify a slug.
 *
 * A name with no `[a-z0-9]` at all (an all-punctuation or non-Latin name)
 * yields `""`. Callers must treat that as "supply an explicit slug" rather
 * than posting it.
 */
export function slugifySpaceName(name: string): string {
  return (
    name
      // Step for step with the server's `slugify` + `normalizeSpaceSlug`.
      // Every stage matters, and the ORDER matters: an earlier version here
      // stopped after the trim, so `"Ops / Notes"` predicted `"ops---notes"`
      // where the server stored `"ops-notes"`. The list lookup then missed
      // forever, the create 409'd, the re-list missed again, and setup
      // reported "taken by a space this key cannot see" — a false diagnosis
      // of a slug it had computed wrong itself.
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .toLowerCase()
      .replace(/[^a-z0-9/]+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/^-+|-+$/g, "")
      .replace(/\/-+|-+\//g, "/")
      .replace(/--+/g, "-")
      .replace(/\//g, "-")
  );
}

/**
 * List every wiki space this key can reach, with the account's usage and caps.
 *
 * Remember what "can reach" means: all `shared` spaces on the account, but
 * only those `individual` spaces owned by THIS key. An absent slug here is
 * evidence, not proof — see `ensureSpace` for the consequence.
 */
export async function listSpaces(auth: ThredzAuth, deps: ThredzDeps = {}): Promise<SpaceInventory> {
  const res = await requestJson(
    { url: `${apiRoot(deps)}/wiki/spaces`, method: "GET", headers: authHeaders(auth) },
    deps,
  );
  if (!res.ok) throw wireFailure("list wiki spaces", res);
  return parseInventory(res.body);
}

/**
 * Create one wiki space. Answers 201 with the created object.
 *
 * Only the fields actually supplied are posted, so the server's own defaults
 * stay authoritative: `slug` derives from `name`, `type` defaults to
 * `"shared"`, `description` is trimmed to 500 characters, and `ownerKeyId`
 * (individual spaces only) defaults to the calling key. Sending explicit
 * nulls here would overwrite defaults we would rather not own.
 *
 * A 409 is translated eagerly, because the two conflicts the server emits mean
 * genuinely different things and must not be collapsed into one message.
 * Callers wanting find-or-create should use `ensureSpace`, not catch this.
 */
export async function createSpace(
  auth: ThredzAuth,
  input: SpaceInput,
  deps: ThredzDeps = {},
): Promise<WikiSpace> {
  const payload: Record<string, unknown> = { name: input.name };
  if (input.slug !== undefined) payload["slug"] = input.slug;
  if (input.type !== undefined) payload["type"] = input.type;
  if (input.description !== undefined) payload["description"] = input.description;

  const res = await requestJson(
    {
      url: `${apiRoot(deps)}/wiki/spaces`,
      method: "POST",
      headers: authHeaders(auth),
      json: payload,
    },
    deps,
  );

  if (res.status === 409) throw conflictFailure(res, input.slug ?? slugifySpaceName(input.name));
  if (!res.ok) throw wireFailure("create wiki space", res);

  // Tolerate both a bare space and a `{ space: … }` envelope: the route
  // returns the former today, and an envelope is the cheap thing to survive.
  const space = parseSpace(res.body) ?? parseSpace(asRecord(res.body)["space"]);
  if (space === undefined) {
    throw new ServiceSetupError(
      "thredz",
      "Thredz created a wiki space but returned no space object",
      {
        status: res.status,
        code: "unexpected_response",
        fix:
          "Check the space list at thredz.crewhaus.ai → Wiki before retrying; the space may " +
          "already exist, and a blind retry would 409.",
      },
    );
  }
  return space;
}

/**
 * List-first, 409-tolerant find-or-create — the only entry point setup should
 * call.
 *
 * The dance, and why each step is load-bearing:
 *  1. Resolve the target slug (explicit, else `slugifySpaceName(name)`), so
 *     the pre-check and the write agree on what we are asking for.
 *  2. List. A hit means the space already exists and we adopt it — but only
 *     if its `type` matches. Adopting a `shared` space when an `individual`
 *     one was requested is a silent security downgrade: the agent's notes
 *     would become readable by every wiki-enabled key on the account. That
 *     mismatch throws.
 *  3. Miss ⇒ create. Because the list is key-scoped, a miss can still collide,
 *     so a `space_slug_conflict` is expected, not exceptional: re-list, and if
 *     the slug now resolves it was our own space (a concurrent setup run, or a
 *     space created between the two calls) and we adopt it.
 *  4. A conflict that STILL misses on the re-list means another key owns that
 *     slug invisibly. That is unrecoverable from here, and says so.
 *  5. `individual_space_exists` is never retried: one individual space per
 *     key is a hard modelling limit, not a transient state.
 */
export async function ensureSpace(
  auth: ThredzAuth,
  input: SpaceInput,
  deps: ThredzDeps = {},
): Promise<{ space: WikiSpace; created: boolean }> {
  // Normalise an EXPLICIT slug too. The server re-slugifies whatever it is
  // given and stores the normalised form, so a caller passing `"Crew Ops"`
  // creates `"crew-ops"` — and a client that kept matching on `"Crew Ops"`
  // would miss it on every subsequent run and 409 forever.
  const slug = slugifySpaceName(input.slug ?? input.name);
  const wanted: SpaceType = input.type ?? "shared";

  if (slug === "") {
    throw new ServiceSetupError("thredz", `"${input.name}" does not normalise to a usable slug`, {
      code: "invalid_slug",
      fix:
        "Wiki slugs keep only [a-z0-9]; give the space an explicit `slug` (or a name with " +
        "Latin letters or digits in it).",
    });
  }

  const before = await listSpaces(auth, deps);
  const seen = findSlug(before.spaces, slug);
  if (seen !== undefined) return { space: adopt(seen, wanted), created: false };

  try {
    // `type` is sent explicitly even when it equals the server default: the
    // visibility of this space is exactly the thing we refuse to leave to a
    // default that could change under us.
    const space = await createSpace(auth, { ...input, slug, type: wanted }, deps);
    return { space, created: true };
  } catch (err) {
    const conflicted =
      err instanceof ServiceSetupError && err.options.code === "space_slug_conflict";
    if (!conflicted) throw err;

    const after = await listSpaces(auth, deps);
    const found = findSlug(after.spaces, slug);
    if (found !== undefined) return { space: adopt(found, wanted), created: false };

    throw new ServiceSetupError(
      "thredz",
      `wiki slug "${slug}" is taken by a space this key cannot see`,
      {
        status: 409,
        code: "space_slug_conflict",
        fix: [
          `Another key on this account owns an individual space with slug "${slug}", and`,
          "individual spaces are invisible to other keys. Choose a different name or slug,",
          "or run setup with the key that owns it.",
        ].join(" "),
      },
    );
  }
}

/**
 * Verify the key reaches the wiki at all — the cheap pre-flight before any
 * write, and the inventory it returns is worth keeping.
 *
 * One `GET /wiki/spaces` exercises all three things that can be wrong before a
 * single space is created: the key is valid (401), it carries a wiki grant
 * (403), and the plan has wiki spaces at all (402). Doing this first matters
 * more here than elsewhere in this package because `/wiki/*` has no
 * `Idempotency-Key`: a write that fails halfway cannot be safely repeated, so
 * the cheapest correct move is to fail before writing.
 */
export async function verifyKey(auth: ThredzAuth, deps: ThredzDeps = {}): Promise<SpaceInventory> {
  return await listSpaces(auth, deps);
}

/* ── internals ─────────────────────────────────────────────────────────── */

/** Normalise the configured base, tolerating a trailing slash. */
function apiRoot(deps: ThredzDeps): string {
  return (deps.apiBase ?? THREDZ_API_BASE).replace(/\/+$/, "");
}

/**
 * Bearer header, with an early, actionable failure for an empty key — better
 * than letting the server answer 401 for a credential we never had.
 */
function authHeaders(auth: ThredzAuth): Record<string, string> {
  const key = auth.apiKey.trim();
  if (key === "") {
    throw new ServiceSetupError("thredz", "no Thredz API key was supplied", {
      code: "missing_credential",
      fix:
        "Set THREDZ_API_KEY to a wiki-enabled key (thredz.crewhaus.ai → API keys); keys look " +
        "like `thredz_` followed by 48 hex characters.",
    });
  }
  return { authorization: `Bearer ${key}` };
}

/** Provider error identifier, when the body carries one. */
function providerCode(body: unknown): string | undefined {
  return readString(body, "code");
}

/** Human message from the body, under either of the two keys Thredz uses. */
function providerMessage(body: unknown): string | undefined {
  return readString(body, "message") ?? readString(body, "error");
}

/** A finite number, or undefined — so a missing limit stays distinguishable from `0`. */
function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** First space with this slug, or undefined. */
function findSlug(spaces: readonly WikiSpace[], slug: string): WikiSpace | undefined {
  return spaces.find((space) => space.slug === slug);
}

/**
 * Adopt an existing space, or refuse when its visibility differs from what was
 * asked for. Returning the wrong type would "succeed" while quietly changing
 * who can read the agent's notes, so this is a throw, not a warning.
 */
function adopt(space: WikiSpace, wanted: SpaceType): WikiSpace {
  if (space.type === wanted) return space;
  const fix =
    wanted === "individual"
      ? [
          `Wiki space "${space.slug}" is shared: every wiki-enabled key on the account can`,
          "read it. Pick a different slug for the individual space, or ask for a shared",
          "space deliberately.",
        ].join(" ")
      : [
          `Wiki space "${space.slug}" is individual and readable only by its owning key. Pick`,
          'a different slug for the shared space, or set the space type to "individual".',
        ].join(" ");
  throw new ServiceSetupError(
    "thredz",
    `wiki space "${space.slug}" already exists as ${space.type}, but ${wanted} was requested`,
    { code: "space_type_mismatch", fix },
  );
}

/**
 * Translate the two 409s, which are NOT interchangeable.
 *
 *  - `space_slug_conflict` ("Wiki space slug already exists in this account")
 *    may well be our own pre-existing space — recoverable, and `ensureSpace`
 *    recovers by re-listing.
 *  - `individual_space_exists` ("This API key already has its individual wiki
 *    space.") means this key already owns a DIFFERENT individual space and can
 *    never own another. One individual space per key is a hard limit on every
 *    plan (Pro and Scale both cap `individualPerKey` at 1), so the remedies
 *    are structural: a separate key, or point the harness at the space that
 *    key already owns.
 */
function conflictFailure(res: JsonResponse, slug: string): ServiceSetupError {
  const code = providerCode(res.body);
  const detail = providerMessage(res.body);

  if (code === "individual_space_exists") {
    const owned =
      "this Thredz key already owns an individual wiki space, and a key may own exactly one";
    return new ServiceSetupError("thredz", detail === undefined ? owned : `${owned} (${detail})`, {
      status: 409,
      code,
      fix:
        "Mint a separate Thredz key for this agent (thredz.crewhaus.ai → API keys) — one " +
        "individual space per key — or point `thredz.space` at the space this key already owns.",
    });
  }

  const taken = `a wiki space with slug "${slug}" already exists on this account`;
  return new ServiceSetupError("thredz", detail === undefined ? taken : `${taken}: ${detail}`, {
    status: 409,
    code: code ?? "space_slug_conflict",
    fix:
      "Use `ensureSpace` to adopt the existing space, or choose a different name or slug. " +
      "Note the slug may belong to another key's individual space, which this key cannot list.",
  });
}

/** Map any non-2xx onto a `ServiceSetupError` whose `fix` names the next move. */
function wireFailure(action: string, res: JsonResponse): ServiceSetupError {
  const code = providerCode(res.body);
  const detail = providerMessage(res.body);
  const message = `Thredz could not ${action} (HTTP ${res.status})${
    detail === undefined ? "" : `: ${detail}`
  }`;
  return new ServiceSetupError("thredz", message, {
    status: res.status,
    code,
    fix: fixFor(res.status, code),
  });
}

/**
 * The remediation line per failure class. Plan caps are quoted from the
 * server's own table because "upgrade your plan" without the numbers makes the
 * operator go looking: free and starter have wiki spaces disabled outright,
 * Pro allows 5 shared / 10 individual, Scale 25 / 50, and both cap individual
 * spaces at 1 per key.
 */
function fixFor(status: number, code: string | undefined): string {
  if (status === 401) {
    return (
      "Check THREDZ_API_KEY — it should be a live key from thredz.crewhaus.ai → API keys, " +
      "shaped `thredz_` plus 48 hex characters."
    );
  }
  if (status === 403) {
    return (
      "Grant this key wiki read-write access (thredz.crewhaus.ai → API keys → permissions), " +
      "then re-run setup; wiki routes reject a key with no wiki grant."
    );
  }
  if (code === "space_quota_exceeded" || (status === 402 && code !== "upgrade_required")) {
    return (
      "This account is at its plan's wiki-space cap (Pro: 5 shared / 10 individual; Scale: " +
      "25 / 50; 1 individual per key on both). Delete an unused space or upgrade the plan."
    );
  }
  if (status === 402) {
    return (
      "Wiki spaces are disabled on the free and starter plans. Upgrade to Pro (5 shared / 10 " +
      "individual) or Scale (25 / 50) at thredz.crewhaus.ai → billing."
    );
  }
  if (status === 404) {
    return (
      "Confirm the API base is right (default https://thredz.crewhaus.ai/api) and that the " +
      "space still exists."
    );
  }
  if (status === 429) {
    return (
      "Wait for the Thredz rate limit to clear, then re-run setup; wiki writes are never " +
      "retried automatically."
    );
  }
  if (status >= 500) {
    return "Thredz is failing server-side. Re-run setup shortly; nothing was written.";
  }
  return "Check the space name, slug and type against the request above, then re-run setup.";
}

/** Parse a whole inventory, dropping entries that are not recognisable spaces. */
function parseInventory(body: unknown): SpaceInventory {
  const root = asRecord(body);
  const raw = root["spaces"];
  const spaces: WikiSpace[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const space = parseSpace(entry);
      if (space !== undefined) spaces.push(space);
    }
  }
  const usage = asRecord(root["usage"]);
  const limits = asRecord(root["limits"]);
  return {
    spaces,
    usage: {
      shared: readCount(usage["shared"]) ?? 0,
      individual: readCount(usage["individual"]) ?? 0,
    },
    limits: {
      shared: readCount(limits["shared"]) ?? null,
      individual: readCount(limits["individual"]) ?? null,
      individualPerKey: readCount(limits["individualPerKey"]) ?? null,
    },
  };
}

/**
 * Narrow one serialized space. An unknown `type` yields `undefined` rather
 * than a widened string: this client branches on visibility, so a value it
 * does not understand must not be allowed to look like one it does.
 */
function parseSpace(value: unknown): WikiSpace | undefined {
  const rec = asRecord(value);
  const id = readString(rec, "id");
  const slug = readString(rec, "slug");
  const name = readString(rec, "name");
  const type = readString(rec, "type");
  if (id === undefined || slug === undefined || name === undefined) return undefined;
  if (type !== "shared" && type !== "individual") return undefined;
  const owner = rec["ownerKeyId"];
  return {
    id,
    slug,
    name,
    type,
    ownerKeyId: typeof owner === "string" && owner !== "" ? owner : null,
    articleCount: readCount(rec["articleCount"]) ?? 0,
  };
}
