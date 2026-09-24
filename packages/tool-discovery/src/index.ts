/**
 * @crewhaus/tool-discovery — finding out what is out there, as deterministic
 * tools: what templates the local marketplace holds, and which federation
 * peers are actually reachable.
 *
 * Two tools with opposite risks, which is why they share a package.
 *
 *   `MarketplaceSearch` never opens a socket. Its danger is the CONTENT it
 *   returns: a template's name, description and author are text its publisher
 *   wrote, and they land in a model's context as the answer to a question the
 *   model asked. That is the indirect prompt-injection channel, and the
 *   defence is that authored text is carried as data — quoted under
 *   `authored`, never interpolated into the tool's own sentences, with control
 *   characters, bidi overrides and zero-width characters replaced and every
 *   substitution reported.
 *
 *   `FederationDiscover` opens sockets to addresses a caller named. Its danger
 *   is the REACH: an unguarded `https://<peer>/…` is a server-side request
 *   forgery primitive. So the address is vetted before the socket, the vetted
 *   IP is what gets dialled, redirects are not followed, and the endpoint the
 *   peer ADVERTISES is vetted too and reported — because whatever federates
 *   next dials that one.
 *
 * Four properties hold across the package.
 *
 *   1. THE REAL REGISTRIES. `@crewhaus/template-registry` owns what a template
 *      is, what an absent `kind` means, whether a grader-template's assets are
 *      valid and whether a signature verifies.
 *      `@crewhaus/federation-discovery` owns how a peer is resolved, what a
 *      peer record must contain, and the TTL and negative-TTL caching of both
 *      answers. This package contributes the schema, the containment, the
 *      network guard, the quoting and the result shape. It contains no second
 *      copy of any of those rules.
 *   2. COULD NOT DETERMINE IS NOT NO. A registry directory that could not be
 *      listed is not an empty marketplace; a manifest the registry source
 *      skipped is not a manifest that is not there; a peer that did not answer
 *      is not an absent peer; and a peer this tool never asked about is not a
 *      peer that is down. Every one of those has its own outcome or its own
 *      entry under `unknowns`, naming the field, the probe and the reason.
 *   3. PARSE, THEN ACT ON THE PARSED VALUE. A peer verdict is decided from an
 *      attempt record written when the socket did or did not produce bytes,
 *      never from the text of a library's exception. A private address is
 *      judged numerically, never by its spelling. A pinned fingerprint is
 *      normalised once and compared in that one representation.
 *   4. NEITHER TOOL CHANGES ANYTHING. Both are read-only: no install, no
 *      federation call, no file written. `MarketplaceSearch` deliberately has
 *      no install flag — fetching a template and trusting it are different
 *      operations with different blast radii, and signature verification
 *      belongs to the one that writes files.
 */

import { type Discovery, type PeerRecord, createDiscovery } from "@crewhaus/federation-discovery";
import {
  type TemplateManifest,
  type TemplateMetadata,
  type TrustRoot,
  firstPartyGraderTemplates,
  templateKind,
  validateGraderTemplate,
  verifyManifest,
} from "@crewhaus/template-registry";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  MAX_GAP_FACTS,
  type OpenedRegistry,
  duplicateNames,
  filterTemplates,
  isRegularFile,
  openLocalRegistry,
  sameMetadata,
  unaccountedFiles,
} from "./lib/marketplace";
import {
  type Attempt,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type Vetted,
  fetchOnce,
  getPeerPolicy,
  vetPeerUrl,
} from "./lib/net";
import { type PeerVerdict, classifyPeer, normalizeFingerprint, tally } from "./lib/peers";
import {
  Unknowns,
  compareStrings,
  contain,
  errText,
  json,
  refusal,
  renderPath,
} from "./lib/result";
import { CAPS, DATA_NOTICE, quoteFields, quoteList, quoteUntrusted } from "./lib/untrusted";

export {
  type DiscoveryConfigInput,
  registerDiscoveryConfig,
  setPeerPolicy,
  getPeerPolicy,
  _resetPeerPolicy,
  _setDnsLookup,
  _setFetch,
} from "./lib/net";

// ---------------------------------------------------------------------------
// MarketplaceSearch
// ---------------------------------------------------------------------------

/** Default page size. Generous enough to browse, small enough to read. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * The keys a manifest signature is checked against.
 *
 * Bound at boot by the runtime, exactly like `setPeerPolicy` — and
 * deliberately NOT a field in the tool's input schema. A trust root a model
 * can supply for itself is not a trust root: it would verify a manifest
 * against the key the manifest came with.
 *
 * When none is bound, a SIGNED manifest's verdict is `null` with an entry
 * under `unknowns`. It is not reported as unsigned and it is not reported as
 * untrusted, because neither is known.
 */
let trustRoot: TrustRoot | undefined;

export function setMarketplaceTrustRoot(next: TrustRoot | undefined): void {
  trustRoot = next;
}

export function getMarketplaceTrustRoot(): TrustRoot | undefined {
  return trustRoot;
}

/** Test-only — back to "no trust root is configured". */
export function _resetMarketplaceTrustRoot(): void {
  trustRoot = undefined;
}

const marketplaceSearchSchema = z.object({
  registryDir: z
    .string()
    .optional()
    .describe(
      "directory of *.json template manifests, relative to the working directory. Omit it to search the first-party grader-template library that ships inside this build, which needs no filesystem at all.",
    ),
  query: z
    .string()
    .optional()
    .describe("case-insensitive substring matched against name, description, author and target"),
  kind: z
    .enum(["spec-template", "grader-template"])
    .optional()
    .describe("what the manifest carries. A manifest that declares no kind is a spec-template."),
  target: z.string().optional().describe('exact target shape, e.g. "assistant"'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`results per page (default ${DEFAULT_LIMIT})`),
  offset: z.number().int().min(0).optional().describe("results to skip (default 0)"),
});

/** The embedded first-party library, built once. Static content, no I/O. */
const firstPartySource = firstPartyGraderTemplates();

type SignatureVerdict =
  | { readonly status: "unsigned" }
  | { readonly status: "verified" }
  | { readonly status: "rejected"; readonly reason: string };

/**
 * The signature verdict for one row, or `null` with the reason recorded.
 *
 * A signature is verified over a canonical JSON that includes `yaml`, and
 * `list()` returns metadata WITHOUT it — so a verdict needs the full manifest,
 * which is a second file read. It is only taken when it can produce an answer:
 * an unsigned manifest is unsigned whatever the trust root says, and with no
 * trust root bound there is nothing to verify against.
 *
 * `fetch()` reads `<registryDir>/<name>.json`, and `<name>` comes out of a
 * file somebody else wrote — so that leaf is contained before the read, not
 * just the directory it sits in.
 */
async function signatureOf(
  meta: TemplateMetadata,
  opened: OpenedRegistry | undefined,
  index: number,
  unknowns: Unknowns,
): Promise<SignatureVerdict | null> {
  const field = `results.${index}.signature`;
  // A field presence check, not a second copy of the verification rule: the
  // rule itself is `verifyManifest`, and it is called below.
  const signed = typeof meta.signature === "string" && meta.signature !== "";
  if (!signed) return { status: "unsigned" };
  if (trustRoot === undefined) {
    unknowns.add(
      field,
      "no trust root is bound",
      "the manifest is signed, but no trust root is configured in this process, so the signature was not checked. Bind one with setMarketplaceTrustRoot(). This is not the same as unsigned and not the same as untrusted.",
    );
    return null;
  }

  const name = String(meta.name);
  let manifest: TemplateManifest;
  let probe: string;
  if (opened === undefined) {
    // The first-party library is a static module: no file, nothing to contain.
    probe = "embedded library";
    try {
      manifest = await firstPartySource.fetch(name);
    } catch (err) {
      unknowns.add(field, probe, errText(err));
      return null;
    }
  } else {
    const leaf = opened.dir.rel === "" ? `${name}.json` : `${opened.dir.rel}/${name}.json`;
    probe = renderPath(leaf);
    const contained = contain("MarketplaceSearch", leaf);
    if (!contained.ok) {
      unknowns.add(
        field,
        probe,
        `the manifest file resolves outside the workspace root, so it was not read: ${contained.reason}`,
      );
      return null;
    }
    try {
      manifest = await opened.source.fetch(name);
    } catch (err) {
      // The registry's own refusal — an unusable name, a file that vanished
      // between the listing and now, a body that stopped parsing. Reported,
      // never rendered as "unsigned".
      unknowns.add(field, probe, errText(err));
      return null;
    }
  }

  // THE ROW AND THE MANIFEST MUST BE THE SAME FILE. `list()` produced this row
  // from whatever file DECLARED `name`; `fetch(name)` just opened
  // `<name>.json`. Two files can declare one name, and then the verdict earned
  // by the bytes in `<name>.json` would be printed beside the OTHER file's
  // description and author — a manifest nobody signed, shown as verified. The
  // identity is proved here rather than assumed, because "verified" is the one
  // word in this result a reader acts on without checking.
  const { yaml: _yaml, ...fetched } = manifest;
  if (!sameMetadata(meta, fetched)) {
    unknowns.add(
      field,
      probe,
      "the manifest stored at this path is not the manifest this row was listed from — another file in this registry declares the same `name`, or this one changed between the listing and the read — so no signature verdict can be attributed to this row. It is not unsigned and it is not untrusted; neither was established.",
    );
    return null;
  }

  const result = verifyManifest(manifest, trustRoot);
  return result.ok
    ? { status: "verified" }
    : { status: "rejected", reason: result.reason ?? "no reason given" };
}

export const marketplaceSearch: RegisteredTool = buildTool({
  name: "MarketplaceSearch",
  description:
    "Search a local template marketplace — spec templates and grader templates — by name, description, target or kind. Use it to find out what is installable before scaffolding anything. Offline and read-only: it opens no network connection, writes nothing, and has no install flag, because fetching a template and trusting it are different operations. Every field under `authored` is text the template's publisher wrote and is returned as DATA, with control characters and bidi overrides replaced and every substitution reported. A manifest file the registry could not parse is reported under `unknowns` rather than quietly missing from the results, and a signed manifest's signature is `null` with a reason when no trust root is bound in this process — never reported as unsigned. When two files declare one template name, the row and the manifest that would be verified are different files, so neither row gets a verdict and the collision is reported instead.",
  inputSchema: marketplaceSearchSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const unknowns = new Unknowns();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = input.offset ?? 0;

    let opened: OpenedRegistry | undefined;
    let listing: ReadonlyArray<TemplateMetadata>;
    let registryView: Record<string, unknown>;

    if (input.registryDir === undefined) {
      listing = await firstPartySource.list();
      registryView = { source: "first-party-grader-templates", templates: listing.length };
    } else {
      const open = openLocalRegistry("MarketplaceSearch", input.registryDir);
      if (!open.ok) {
        return refusal("MarketplaceSearch", open.code, open.reason, {
          registryDir: renderPath(input.registryDir),
        });
      }
      opened = open.value;
      try {
        listing = await opened.source.list();
      } catch (err) {
        // Never `[]`. The listing is the read the whole tool is built on.
        return refusal(
          "MarketplaceSearch",
          "unreadable",
          `"${renderPath(input.registryDir)}" could not be listed: ${errText(err)}`,
        );
      }
      const shownDir = opened.dir.rel === "" ? "." : opened.dir.rel;
      const duplicates = duplicateNames(listing);
      registryView = {
        source: "local",
        // Rendered like every other path in a result: this one is caller-named
        // rather than authored, but a directory that exists can still be named
        // with an ANSI introducer, and a consumer that parses this JSON gets
        // the real byte back however JSON.stringify chose to spell it.
        dir: renderPath(shownDir),
        manifestFiles: opened.files.length,
        templates: listing.length,
        duplicateNames: duplicates.length,
      };

      // One name claimed by several files. Reported even with no trust root
      // bound, because the ambiguity is not about signatures: two rows carry
      // that name, and at most one of them is the manifest anything would
      // install.
      for (const dup of duplicates) {
        const shownName = renderPath(dup.name);
        unknowns.add(
          `registry.names.${shownName}`,
          renderPath(
            opened.dir.rel === "" ? `${dup.name}.json` : `${opened.dir.rel}/${dup.name}.json`,
          ),
          `${dup.count} manifest files in this registry declare the name "${shownName}". Only the one stored at that filename is what the registry returns for it, and the listing does not say which row came from which file — so the rows carrying this name cannot be told apart.`,
        );
      }

      // The gap between the files on disk and the names in the listing. The
      // registry source skips a manifest it cannot parse; something has to say
      // it did, or "3 templates" reads as the whole marketplace.
      const gaps = unaccountedFiles(opened.files, listing);
      for (const file of gaps.slice(0, MAX_GAP_FACTS)) {
        const rel = opened.dir.rel === "" ? file : `${opened.dir.rel}/${file}`;
        unknowns.add(
          // The filename came off a readdir, so it is text somebody else chose
          // and it is going into a result as a KEY — rendered, never raw.
          `registry.files.${renderPath(file)}`,
          renderPath(rel),
          isRegularFile(opened.dir.real, file)
            ? "no template in the listing is stored under this filename. Either the file is not valid JSON — the registry source skips one it cannot parse, and that template really is missing — or its `name` differs from its filename, in which case the template IS listed and only a fetch by name will look somewhere else."
            : "this name is not a regular file, so the registry source skipped it.",
        );
      }
      if (gaps.length > MAX_GAP_FACTS) {
        // Bounded, and the bound is declared with the true total. A quietly
        // shortened list of what could not be read is the failure this whole
        // section exists to prevent.
        unknowns.add(
          "registry.files",
          renderPath(shownDir),
          `${gaps.length} manifest files here are not stored under a listed template's name; the first ${MAX_GAP_FACTS} are reported individually and the rest are not listed in this result.`,
        );
      }
    }

    const matched = filterTemplates(listing, {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
    });
    const page = matched.slice(offset, offset + limit);

    const results: Array<Record<string, unknown>> = [];
    for (const [i, meta] of page.entries()) {
      const { authored, sanitized } = quoteFields([
        ["name", meta.name, CAPS.name],
        ["description", meta.description, CAPS.description],
        ["author", meta.author, CAPS.author],
        ["target", meta.target, CAPS.target],
        // `version` is authored too, and was being quoted OUTSIDE `quoteFields`
        // — so a version carrying a bidi override was rewritten with nothing
        // in `authoredSanitized` saying so.
        ["version", meta.version, CAPS.version],
      ] as const);
      const kind = templateKind(meta);
      const row: Record<string, unknown> = {
        name: authored.name,
        version: authored.version,
        kind,
        authored,
        authoredSanitized: sanitized,
        signature: await signatureOf(meta, opened, i, unknowns),
      };
      if (kind === "grader-template") {
        // The registry's own structural check, not a second one. A grader
        // template's assets are written straight into somebody's eval/
        // directory, so a listing that shows one as available without saying
        // its assets do not validate is a listing that wastes an afternoon.
        const check = validateGraderTemplate(meta as TemplateManifest);
        row["assets"] = check.ok
          ? { ok: true }
          : { ok: false, reason: quoteUntrusted(check.reason ?? "", CAPS.description).text };
      }
      results.push(row);
    }

    return json({
      tool: "MarketplaceSearch",
      status: "ok",
      registry: registryView,
      filters: {
        query: input.query ?? null,
        kind: input.kind ?? null,
        target: input.target ?? null,
      },
      matched: matched.length,
      offset,
      limit,
      shown: results.length,
      dataNotice: DATA_NOTICE,
      results,
      unknowns: unknowns.list(),
    });
  },
});

// ---------------------------------------------------------------------------
// FederationDiscover
// ---------------------------------------------------------------------------

/** Longest peer list one sweep will take. Past this, sweep in batches. */
const MAX_PEERS = 100;

/**
 * Attempts recorded by the fetcher during the CURRENT peer's lookup.
 *
 * Cleared before each `discover()` and read after it, so "an attempt exists"
 * means "a socket was attempted on this call" — which is exactly the fact that
 * separates a peer that did not answer from one the library answered out of
 * its negative cache without dialling at all.
 */
let attempts: Attempt[] = [];
/** The deadline and cancellation the current sweep is running under. */
let sweepTimeoutMs = DEFAULT_TIMEOUT_MS;
let sweepSignal: AbortSignal | undefined;

let discovery: Discovery | undefined;

function peerDiscovery(): Discovery {
  if (discovery !== undefined) return discovery;
  discovery = createDiscovery({
    // The discovery library owns the lookup, the record shape and both TTLs.
    // This package owns exactly one thing inside it: what happens on the wire.
    wellKnownFetcher: async (url) => {
      const { attempt, body } = await fetchOnce(url, {
        timeoutMs: sweepTimeoutMs,
        ...(sweepSignal !== undefined ? { signal: sweepSignal } : {}),
      });
      attempts.push(attempt);
      if (attempt.kind !== "answered") throw new Error(attempt.reason);
      if (attempt.truncated) {
        // A CUT body is a DIFFERENT document, and the prefix can still be
        // valid JSON — pad a well-formed record with whitespace past the cap
        // and it parses. Whatever followed the cut is unread, and in JSON a
        // later duplicate key WINS: the bytes this tool never saw could carry
        // a second `endpoint`. Parsing the prefix and reporting the peer
        // healthy would be reporting a fact about a document the peer did not
        // serve. The attempt record already says `answered` + `truncated`, and
        // the classifier turns that into `unhealthy:body-too-large` — the peer
        // is up, and its answer is unusable.
        throw new Error("the .well-known body was larger than the cap and was not parsed");
      }
      return { status: attempt.status, body: body ?? "" };
    },
  });
  return discovery;
}

/**
 * Test-only — drop the shared discovery and its cache.
 *
 * The cache is shared across calls ON PURPOSE: it is the library's, it is what
 * keeps a fleet sweep from re-resolving every peer every minute, and its
 * negative TTL is what keeps a misconfigured peer from causing a DNS storm.
 * A suite that did not reset it would carry one test's peer into the next.
 */
export function _resetDiscovery(): void {
  discovery = undefined;
  attempts = [];
}

const federationDiscoverSchema = z.object({
  peers: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_PEERS)
    .describe('deployment ids to look up, e.g. "deployment-b.example"'),
  pins: z
    .record(z.string())
    .optional()
    .describe(
      "deployment id -> the SHA-256 public-key fingerprint that peer must present. Separators and case are normalised; a value that is not a 64-character SHA-256 fingerprint refuses that peer rather than skipping the check.",
    ),
  requireVersion: z
    .string()
    .optional()
    .describe(
      "the exact federation protocol version every peer must report. Compared for equality — this is not a semver range.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`per-peer deadline in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
  refresh: z
    .boolean()
    .optional()
    .describe("clear the discovery cache first, so every peer is looked up again"),
});

/**
 * What to report for `record.endpointDialable`.
 *
 * `true` only when an address was actually established for the advertised
 * endpoint and it is one this process would dial. `false` ONLY when the guard
 * looked and refused — a `false` reads as "checked and rejected" and must
 * never stand in for "not checked". Everything else is `null` plus an entry
 * under `unknowns`:
 *
 *   - the name did not resolve from here (a fact about here, not there);
 *   - the origin is not on this process's allow-list (a policy fact about this
 *     process);
 *   - `allowPrivateHosts` is set, which short-circuits resolution entirely, so
 *     `ok: true` came back without anything having been looked up. That case
 *     was reporting `true`.
 */
function endpointDialable(vet: Vetted | undefined): boolean | null {
  if (vet === undefined) return null;
  if (vet.ok) return vet.resolved ? true : null;
  return vet.code === "unresolvable" || vet.code === "not-allow-listed" ? null : false;
}

/** Is this peer currently answerable from the library's own cache? */
function cachedNow(d: Discovery, peer: string, now: number): boolean {
  return d.cacheStats().expirations.some((e) => e.deployment === peer && e.expiresAt > now);
}

export const federationDiscover: RegisteredTool = buildTool({
  name: "FederationDiscover",
  description:
    "Look up federation peers and report which of them are actually reachable. Each peer comes back as exactly one of: healthy (it answered with a well-formed peer record and everything you pinned held), unhealthy (it answered, and its answer is wrong — read the reason), unreachable (nothing came back), refused (a guard stopped the request, so nothing at all is known about that peer) or undetermined (the sweep was cut short before that peer's turn). A peer that did not answer is never reported as absent and never as present. It reaches the network over HTTPS to each peer's /.well-known/crewhaus.json: loopback, link-local, RFC1918 and metadata-service addresses are refused, the vetted IP is what gets dialled, redirects are not followed, and the endpoint a peer advertises is vetted too and reported — because that is the address anything federating with it dials next. It makes no federation call, so healthy means resolvable and self-describing, not able to serve traffic. A pin whose key names no peer in this sweep is listed under `pinsNotApplied` rather than dropped.",
  inputSchema: federationDiscoverSchema,
  readOnly: true,
  // The sweep's deadline, cancellation and attempt record are per-sweep state
  // on a shared discovery client, and the discovery cache the sweep reads is
  // shared too. Two sweeps at once would interleave both.
  concurrencySafe: false,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const unknowns = new Unknowns();
    const d = peerDiscovery();
    if (input.refresh === true) d.reset();

    sweepTimeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    sweepSignal = ctx?.signal;

    // OWN ENTRIES ONLY, in a Map with no prototype behind it. `input.pins` is
    // an ordinary object, so `pins[peer]` walks `Object.prototype`: the
    // discovery library's deployment-id charset accepts "constructor",
    // "toString", "valueOf" and "hasOwnProperty", and each of those hands back
    // a FUNCTION that the fingerprint normaliser then calls `.replace` on. The
    // whole sweep died with a TypeError instead of returning a result.
    const pins = new Map<string, string>(Object.entries(input.pins ?? {}));

    // Deduplicated, caller order preserved: a repeated peer would otherwise be
    // counted twice in the tally, and the second lookup would only ever read
    // the first one's cache entry.
    const seen = new Set<string>();
    const peers: string[] = [];
    let duplicates = 0;
    for (const raw of input.peers) {
      if (seen.has(raw)) {
        duplicates += 1;
        continue;
      }
      seen.add(raw);
      peers.push(raw);
    }

    const rows: Array<Record<string, unknown>> = [];
    const verdicts: PeerVerdict[] = [];

    for (const [i, peer] of peers.entries()) {
      const shown = quoteUntrusted(peer, CAPS.url).text;

      if (ctx?.signal?.aborted === true) {
        // Not attempted. Reporting the tail of a cancelled sweep as unreachable
        // would put healthy peers in the down column.
        const verdict: PeerVerdict = {
          outcome: "undetermined",
          code: "undetermined:not-attempted",
          reason: "the sweep was cancelled before this peer was looked up",
        };
        verdicts.push(verdict);
        rows.push({ peer: shown, ...verdict, cached: false });
        continue;
      }

      // The pin is normalised BEFORE the socket, and a pin that is not a
      // fingerprint refuses the peer instead of being dropped. A check that
      // cannot be performed must not read as a check that passed.
      let pin: string | undefined;
      const rawPin = pins.get(peer);
      if (rawPin !== undefined) {
        const normalized = normalizeFingerprint(rawPin);
        if (normalized === null) {
          const verdict: PeerVerdict = {
            outcome: "refused",
            code: "refused:bad-pin",
            reason:
              "the pin supplied for this peer is not a 64-character SHA-256 fingerprint, so it could not be checked and the peer was not contacted",
          };
          verdicts.push(verdict);
          rows.push({ peer: shown, ...verdict, cached: false });
          continue;
        }
        pin = normalized;
      }

      const fromCache = cachedNow(d, peer, Date.now());
      attempts = [];
      let record: PeerRecord | undefined;
      let error: string | undefined;
      try {
        record = await d.discover(peer);
      } catch (err) {
        error = errText(err);
      }
      const attempt = attempts[attempts.length - 1];

      // The address the peer told us to use next. Vetted with the same gate
      // the peer id went through, because nothing else is going to.
      let endpointVet: Vetted | undefined;
      if (record !== undefined) {
        endpointVet = await vetPeerUrl(record.endpoint);
        // Two verdicts on the advertised endpoint are NOT findings about the
        // peer — see UNHEALTHY_ENDPOINT_CODES. They are recorded as what they
        // are: facts this process could not establish.
        if (!endpointVet.ok && endpointVet.code === "unresolvable") {
          unknowns.add(
            `peers.${i}.record.endpointDialable`,
            quoteUntrusted(record.endpoint, CAPS.url).text,
            `the endpoint this peer advertises could not be resolved from here, so whether anything can dial it is unknown: ${endpointVet.reason}`,
          );
        }
        if (!endpointVet.ok && endpointVet.code === "not-allow-listed") {
          unknowns.add(
            `peers.${i}.record.endpointDialable`,
            quoteUntrusted(record.endpoint, CAPS.url).text,
            "the endpoint this peer advertises is not on this process's federation allow-list, so it was not checked. That is a policy fact about this process, not a fault of the peer.",
          );
        }
        if (endpointVet.ok && !endpointVet.resolved) {
          // `allowPrivateHosts` leaves the guard nothing to decide, so it
          // returns ok WITHOUT resolving. Passing that through as
          // `endpointDialable: true` claims a fact nothing established.
          unknowns.add(
            `peers.${i}.record.endpointDialable`,
            quoteUntrusted(record.endpoint, CAPS.url).text,
            "this process runs with allowPrivateHosts, which short-circuits name resolution, so the endpoint this peer advertises was not resolved and whether anything can reach it is unknown.",
          );
        }
      }

      const verdict = classifyPeer({
        ...(attempt !== undefined ? { attempt } : {}),
        fromCache,
        ...(record !== undefined ? { record } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(endpointVet !== undefined ? { endpointVet } : {}),
        expect: {
          ...(pin !== undefined ? { pin } : {}),
          ...(input.requireVersion !== undefined ? { version: input.requireVersion } : {}),
        },
      });
      verdicts.push(verdict);

      const row: Record<string, unknown> = {
        peer: shown,
        ...verdict,
        cached: fromCache,
        pinned: pin !== undefined,
      };
      if (record !== undefined) {
        const shapes = quoteList(record.supportedShapes, CAPS.shape);
        const quoted = quoteFields([
          ["endpoint", record.endpoint, CAPS.url],
          ["version", record.version, CAPS.version],
        ] as const);
        // The substitutions are DECLARED, exactly as MarketplaceSearch declares
        // them and exactly as `dataNotice` promises for both tools. They were
        // being made silently here: a peer's version could be rewritten and the
        // result said nothing, which is the quiet alteration the notice was
        // written against.
        const recordSanitized = [...quoted.sanitized];
        if (shapes.notes.length > 0) {
          recordSanitized.push(`supportedShapes:${shapes.notes.join("+")}`);
        }
        row["record"] = {
          // The peer's own fingerprint: 64 hex characters by the library's own
          // parse, so there is nothing in it to quote.
          publicKeyFingerprint: record.publicKeyFingerprint,
          authored: {
            endpoint: quoted.authored.endpoint,
            version: quoted.authored.version,
            supportedShapes: shapes.items,
          },
          authoredSanitized: recordSanitized.sort(compareStrings),
          shapesTruncated: shapes.truncated,
          // `null`, never `false`, when the answer was not established: a
          // false here would read as "this address was checked and rejected".
          endpointDialable: endpointDialable(endpointVet),
        };
      }
      if (attempt !== undefined) {
        row["attempt"] = {
          kind: attempt.kind,
          // `truncated` and `location` were being dropped here. Both are facts
          // about how much of the peer's answer was actually read, and a row
          // that omits them reads as a complete answer.
          ...(attempt.kind === "answered"
            ? {
                status: attempt.status,
                bytes: attempt.bytes,
                truncated: attempt.truncated,
                ...(attempt.location !== undefined
                  ? { location: quoteUntrusted(attempt.location, CAPS.url).text }
                  : {}),
              }
            : { code: attempt.code }),
        };
      }
      rows.push(row);
    }

    // A pin whose key names no peer in this sweep was never applied to
    // anything. Silently dropping it leaves an operator who mistyped one id
    // reading a fleet reported healthy with the pin they thought they set
    // unenforced — and `pinned: false` on a row is only visible if you already
    // suspect it.
    const pinsNotApplied = [...pins.keys()]
      .filter((key) => !seen.has(key))
      .sort(compareStrings)
      .map((key) => quoteUntrusted(key, CAPS.url).text);

    const policy = getPeerPolicy();
    return json({
      tool: "FederationDiscover",
      status: "ok",
      summary: tally(verdicts),
      ...(duplicates > 0 ? { duplicatePeersIgnored: duplicates } : {}),
      ...(pinsNotApplied.length > 0 ? { pinsNotApplied } : {}),
      posture: {
        allowPrivateHosts: policy.allowPrivateHosts === true,
        allowList:
          policy.allowedOrigins === undefined
            ? null
            : [...policy.allowedOrigins].sort(compareStrings),
        followsRedirects: false,
        makesFederationCall: false,
      },
      dataNotice: DATA_NOTICE,
      peers: rows,
      unknowns: unknowns.list(),
    });
  },
});

export const DISCOVERY_TOOLS: ReadonlyArray<RegisteredTool> = [
  marketplaceSearch,
  federationDiscover,
];
