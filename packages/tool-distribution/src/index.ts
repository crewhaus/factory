/**
 * @crewhaus/tool-distribution — the four files a release publishes, and
 * whether a published one is telling the truth.
 *
 * A release binary reaches people through package managers: a Homebrew
 * formula, a Debian control paragraph, a scoop manifest and a winget
 * installer manifest. Each is a small file that says "download THIS, check it
 * against THIS sha256, then run it". Two things can go wrong, and they are
 * different jobs:
 *
 *   - `PackageManifestGenerate` renders the four from one set of facts, so
 *     they cannot disagree with each other about a version or a checksum.
 *   - `PackageManifestVerify` takes manifests that are already published and
 *     checks that what they promise is true: the URLs resolve, the bytes hash
 *     to the sha the file claims, the version in the file matches the version
 *     in the URLs, and the winget digest is uppercase like the rest of the
 *     repository it is submitted to.
 *
 * WHAT THIS PACKAGE DOES NOT DO IS RENDER. `@crewhaus/single-binary-cli` owns
 * the four renderers, their output is pinned byte-for-byte by goldens in that
 * package, and those bytes ship to brew, apt, scoop and winget on every real
 * release. This package consumes them through the `ProductIdentity` parameter
 * they were given for the purpose. A second renderer would be a second answer
 * to a question that already has one, and the first one that drifted would do
 * so in a file nobody reads until an install fails.
 *
 * THE DISTINCTION THAT MATTERS MOST is in the verify result. An asset that is
 * MISSING (a definite 404) and an asset whose hash DISAGREES (the loud one)
 * are both answers. An asset that could not be FETCHED — DNS failed, the
 * deadline elapsed, the body stopped short, the SSRF guard refused the hop —
 * is not an answer at all, and it is reported as its own outcome with its own
 * reason. A verifier that folds "could not reach it" into "hash mismatch"
 * blocks a good release; one that folds it into "verified" ships an unverified
 * one. Three outcomes, never two.
 */
import { readFileSync, statSync } from "node:fs";
import {
  CREWHAUS_PRODUCT,
  type ManifestInputs,
  type ProductIdentity,
  renderDebianControl,
  renderHomebrewFormula,
  renderScoopManifest,
  renderWingetManifest,
} from "@crewhaus/single-binary-cli";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  MANIFEST_KINDS,
  type ManifestKind,
  TARGET_KEYS,
  checkDownloadBaseUrl,
  checkHomepage,
  checkProduct,
  checkShas,
  checkVersion,
  codePointLabel,
  firstControlChar,
  homebrewClassFor,
  manifestFilename,
  privateHostReason,
} from "./lib/inputs";
import {
  type AssetProbe,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_BYTES,
  MAX_TIMEOUT_MS,
  type UnknownReason,
  probeAsset,
  safeLabel,
  sha256Hex,
} from "./lib/net";
import {
  type DeclaredAsset,
  type Finding,
  type ParsedManifest,
  detectKind,
  parseManifest,
  versionInUrl,
  versionTokensInUrl,
} from "./lib/parse";
import { ToolPermissionError, resolveSafe } from "./paths";

export { _setFetch, type DistributionFetch } from "./lib/net";
export { MANIFEST_KINDS, REQUIRED_TARGETS, TARGET_KEYS } from "./lib/inputs";

/** Compact JSON — every byte returned is a byte in somebody's context window. */
const json = (value: unknown): string => JSON.stringify(value);

/** A manifest is a few kilobytes. Anything past this is not one. */
const MAX_MANIFEST_CHARS = 512 * 1024;

const kindField = z.enum(MANIFEST_KINDS);

const productSchema = z
  .object({
    binaryName: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "the executable's name; it appears in every download URL and as the Debian Package",
      ),
    formulaClass: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "the Ruby class in the Homebrew formula; Homebrew requires it to match the filename",
      ),
    shortDescription: z.string().min(1).max(240).describe("one line, used by all four formats"),
    license: z.string().min(1).max(64).describe("an SPDX identifier"),
    debian: z.object({
      section: z.string().min(1).max(64),
      maintainer: z.string().min(1).max(240),
      depends: z.string().max(400),
      longDescription: z
        .array(z.string().max(240))
        .min(1)
        .max(40)
        .describe(
          "continuation lines WITHOUT the leading space the control format needs — the renderer adds it, and a line that arrives carrying one is published doubly indented",
        ),
    }),
    winget: z.object({
      packageIdentifier: z.string().min(1).max(128).describe("Publisher.Package"),
      publisher: z.string().min(1).max(128),
      author: z.string().min(1).max(128),
      longDescription: z.string().min(1).max(400),
      tags: z.array(z.string().min(1).max(40)).max(16),
    }),
    homebrewMacosNote: z
      .array(z.string().max(240))
      .max(40)
      .optional()
      .describe("lines emitted as a comment inside the formula's on_macos block, without the '# '"),
  })
  .describe("defaults to the crewhaus CLI's own identity when omitted");

/**
 * The zod shape and `ProductIdentity` are the same fields; this is the cast
 * that says so once, where the reason can be written down. zod gives
 * mutable arrays, the renderer wants readonly ones, and that is the whole
 * difference.
 */
function toProduct(input: z.infer<typeof productSchema>): ProductIdentity {
  return {
    binaryName: input.binaryName,
    formulaClass: input.formulaClass,
    shortDescription: input.shortDescription,
    license: input.license,
    debian: {
      section: input.debian.section,
      maintainer: input.debian.maintainer,
      depends: input.debian.depends,
      longDescription: input.debian.longDescription,
    },
    winget: {
      packageIdentifier: input.winget.packageIdentifier,
      publisher: input.winget.publisher,
      author: input.winget.author,
      longDescription: input.winget.longDescription,
      tags: input.winget.tags,
    },
    homebrewMacosNote: input.homebrewMacosNote,
  };
}

/** Selected kinds, deduplicated and always in the canonical order. */
function selectedKinds(requested: ReadonlyArray<ManifestKind> | undefined): ManifestKind[] {
  if (requested === undefined) return [...MANIFEST_KINDS];
  const set = new Set(requested);
  return MANIFEST_KINDS.filter((kind) => set.has(kind));
}

function refusal(tool: string, problems: ReadonlyArray<string>): string {
  if (problems.length === 1) return `${tool} refused: ${problems[0]}`;
  return `${tool} refused, ${problems.length} problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// PackageManifestGenerate

export const packageManifestGenerate: RegisteredTool = buildTool({
  name: "PackageManifestGenerate",
  description:
    "Render the Homebrew formula, Debian control paragraph, scoop manifest and winget installer manifest for a released binary, from one version, one download base URL and the per-target SHA-256 sums. Use it at release time so the four files cannot disagree with each other, and to regenerate them deterministically rather than hand-editing last release's copy. It refuses rather than publishing something broken: a sha that is not 64 hex characters or is missing for a target a selected manifest needs, a version the Homebrew formula will reject, a download URL that is not https or points into private address space, and a product identity whose Debian description lines already carry the leading space the format adds. Nothing is fetched and nothing is written to disk — the four files come back as text.",
  inputSchema: z.object({
    version: z
      .string()
      .min(1)
      .max(128)
      .describe("semver-shaped: MAJOR.MINOR.PATCH, optionally -prerelease and +build"),
    homepage: z.string().min(1).max(512).describe("the project's homepage, http(s)"),
    downloadBaseUrl: z
      .string()
      .min(1)
      .max(512)
      .describe(
        "https base the binaries hang off; each URL is `<base>/<binary>-<platform>-<arch>-<version>`",
      ),
    sha256: z
      .record(z.string().min(1).max(200))
      .describe(
        `sha256 per build target, keyed ${TARGET_KEYS.join(", ")} — 64 hex characters each`,
      ),
    manifests: z
      .array(kindField)
      .min(1)
      .max(4)
      .optional()
      .describe("which of the four to render; defaults to all four"),
    product: productSchema.optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const kinds = selectedKinds(input.manifests);
    const product = input.product === undefined ? CREWHAUS_PRODUCT : toProduct(input.product);

    const problems: string[] = [];
    const notes: string[] = [];

    const versionProblem = checkVersion(input.version);
    if (versionProblem !== undefined) problems.push(versionProblem);

    const base = checkDownloadBaseUrl(input.downloadBaseUrl);
    if (base.ok) notes.push(...base.notes);
    else problems.push(base.message);

    const homepage = checkHomepage(input.homepage);
    if (homepage.ok) notes.push(...homepage.notes);
    else problems.push(homepage.message);

    problems.push(...checkProduct(product));

    const shas = checkShas(input.sha256, kinds);
    if (shas.ok) notes.push(...shas.notes);
    else problems.push(shas.message);

    if (problems.length > 0 || !base.ok || !homepage.ok || !shas.ok) {
      return refusal("PackageManifestGenerate", problems);
    }

    if (kinds.includes("homebrew")) {
      const expected = homebrewClassFor(product.binaryName);
      if (expected !== product.formulaClass) {
        // Not a refusal: the mapping from filename to class is Homebrew's,
        // `ProductIdentity` keeps them separate on purpose, and `brew audit`
        // is the authority. Saying it is still worth a line, because the
        // failure mode is a tap that installs and then fails audit.
        notes.push(
          `formulaClass is "${product.formulaClass}" but Homebrew derives "${expected}" from the filename ${product.binaryName}.rb — brew audit will want them to agree`,
        );
      }
    }

    const inputs: ManifestInputs = {
      version: input.version,
      homepage: homepage.url,
      downloadBaseUrl: base.url,
      sha256: shas.sha256,
      product,
    };

    const rendered: { kind: ManifestKind; filename: string; text: string }[] = [];
    try {
      for (const kind of kinds) {
        rendered.push({
          kind,
          filename: manifestFilename(kind, product),
          text: renderOne(kind, inputs),
        });
      }
    } catch (err) {
      // Every refusal the renderers make is one this tool checks first, so
      // reaching here means a check missed a case. Say that, rather than
      // dressing a renderer's message up as a caller mistake.
      return `PackageManifestGenerate could not render: ${(err as Error).message} — this got past the checks in this tool, which is a defect in them`;
    }

    // The assets are read back out of the RENDERED text with the same reader
    // PackageManifestVerify uses, rather than re-derived from the URL template.
    // Restating the template here would be the second copy that drifts, and
    // reading it back also proves the output is parseable.
    const assets: {
      manifest: ManifestKind;
      target: string;
      url: string;
      sha256: string;
    }[] = [];
    const readbackFindings: string[] = [];
    for (const file of rendered) {
      const parsed = parseManifest(file.text, file.filename, file.kind);
      if (!parsed.ok) {
        readbackFindings.push(`${file.filename}: ${parsed.message}`);
        continue;
      }
      for (const finding of parsed.manifest.findings) {
        if (finding.severity === "error") {
          readbackFindings.push(`${file.filename}: ${finding.message}`);
        }
      }
      for (const asset of parsed.manifest.assets) {
        assets.push({
          manifest: file.kind,
          target: asset.label,
          url: asset.url,
          sha256: asset.declaredSha256,
        });
      }
    }
    if (readbackFindings.length > 0) {
      // A rendered file that does not read back cleanly is a bug in this
      // package or in the renderers, not a caller error, and shipping it
      // quietly is how a broken formula reaches a tap.
      return `PackageManifestGenerate rendered a manifest that does not read back cleanly: ${readbackFindings.join("; ")}`;
    }

    return json({
      version: input.version,
      product: {
        binaryName: product.binaryName,
        formulaClass: product.formulaClass,
        packageIdentifier: product.winget.packageIdentifier,
        isDefault: input.product === undefined,
      },
      downloadBaseUrl: base.url,
      homepage: homepage.url,
      manifests: rendered.map((file) => {
        const bytes = new TextEncoder().encode(file.text);
        return {
          kind: file.kind,
          filename: file.filename,
          bytes: bytes.byteLength,
          // The manifest's own digest, so a release log can pin the file it
          // published rather than the intention to publish it.
          sha256: sha256Hex(bytes),
          text: file.text,
        };
      }),
      assets,
      ...(notes.length > 0 ? { notes } : {}),
    });
  },
});

function renderOne(kind: ManifestKind, inputs: ManifestInputs): string {
  switch (kind) {
    case "homebrew":
      return renderHomebrewFormula(inputs);
    case "debian":
      return renderDebianControl(inputs);
    case "scoop":
      // The same serialisation `writeAllManifests` puts on disk, so the text
      // this tool returns is the file a release would publish.
      return `${JSON.stringify(renderScoopManifest(inputs), null, 2)}\n`;
    default:
      return renderWingetManifest(inputs);
  }
}

// ---------------------------------------------------------------------------
// PackageManifestVerify

/** What a single download instruction turned out to be. */
type AssetOutcome = "verified" | "mismatch" | "missing" | "unchecked";

type AssetRow = {
  manifest: ManifestKind;
  source: string;
  target: string;
  url: string;
  declaredSha256: string;
  outcome: AssetOutcome;
  reason?: UnknownReason | "notRequested" | "malformedSha" | AssetUrlFlawCode;
  message?: string;
  computedSha256?: string;
  status?: number;
  bytes?: number;
  versionInUrl?: string;
  /** Set only when a redirect moved the download somewhere else. */
  fetchedFrom?: string;
};

export const packageManifestVerify: RegisteredTool = buildTool({
  name: "PackageManifestVerify",
  description:
    "Check that a published package manifest is telling the truth: fetch every URL it points at, hash the bytes, and compare them to the sha256 the manifest claims. Also checks that the version in the file matches the version in its download URLs, that a Debian paragraph's continuation lines are intact, and that a winget InstallerSha256 is uppercase. Takes one manifest or all four, as text or as workspace-relative paths, and recognises the format on its own. Every download is streamed and hashed as it arrives, never held in memory, and capped. The result distinguishes three outcomes and never collapses them: the asset is MISSING (a definite 404), the hash DISAGREES (a definite mismatch), or the check COULD NOT BE MADE (DNS failed, the deadline elapsed, the body stopped short, the cap was hit, the SSRF guard refused the hop) — with the reason named, because 'could not reach it' is neither a pass nor a failure.",
  inputSchema: z.object({
    manifests: z
      .array(
        z.object({
          text: z.string().min(1).max(MAX_MANIFEST_CHARS).describe("the manifest, verbatim"),
          kind: kindField.optional().describe("skip format detection"),
          label: z.string().min(1).max(200).optional().describe("what to call it in the result"),
        }),
      )
      .min(1)
      .max(8)
      .optional(),
    paths: z
      .array(z.string().min(1).max(1024))
      .min(1)
      .max(8)
      .optional()
      .describe("workspace-relative manifest files to read instead of, or as well as, `manifests`"),
    expectVersion: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("the release this is supposed to be; every manifest is checked against it"),
    download: z
      .boolean()
      .optional()
      .describe(
        "fetch and hash the assets; defaults to true. false runs the structural checks only, and every asset then reports as unchecked rather than as verified",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_BYTES)
      .optional()
      .describe(`per-asset download cap; defaults to ${DEFAULT_MAX_BYTES}`),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`per-asset deadline in ms; defaults to ${DEFAULT_TIMEOUT_MS}`),
  }),
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: this one crosses a network boundary, so it says so.
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const sources: { text: string; kind?: ManifestKind; label: string }[] = [];
    const unreadable: { source: string; message: string }[] = [];

    for (const entry of input.manifests ?? []) {
      sources.push({
        text: entry.text,
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        label: entry.label ?? `manifest[${sources.length}]`,
      });
    }

    for (const path of input.paths ?? []) {
      let safe: ReturnType<typeof resolveSafe>;
      try {
        safe = resolveSafe("PackageManifestVerify", path);
      } catch (err) {
        // Containment is policy, not a per-file outcome: a path that escapes
        // the workspace is refused outright rather than reported as one more
        // row that could not be checked.
        if (err instanceof ToolPermissionError) return err.message;
        throw err;
      }
      try {
        const size = statSync(safe.real).size;
        if (size > MAX_MANIFEST_CHARS) {
          unreadable.push({
            source: safe.rel,
            message: `the file is ${size} bytes, past the ${MAX_MANIFEST_CHARS}-byte limit for a package manifest — it was not read`,
          });
          continue;
        }
        sources.push({ text: readFileSync(safe.real, "utf8"), label: safe.rel });
      } catch (err) {
        // A file that cannot be read has not been checked. It is not a
        // manifest that passed and not one that failed.
        unreadable.push({ source: safe.rel, message: (err as Error).message });
      }
    }

    if (sources.length === 0 && unreadable.length === 0) {
      return "PackageManifestVerify needs at least one manifest — pass `manifests` (text) or `paths` (workspace-relative files)";
    }

    const parsed: ParsedManifest[] = [];
    for (const source of sources) {
      const kind = source.kind ?? detectKind(source.text);
      if (kind === undefined) {
        // Undecided is its own answer. Guessing "homebrew" and finding no
        // url/sha pairs would report a file nobody could read as a file with
        // nothing wrong in it.
        unreadable.push({
          source: source.label,
          message: `could not tell which of ${MANIFEST_KINDS.join(", ")} this is — pass \`kind\` if it is one of them`,
        });
        continue;
      }
      const outcome = parseManifest(source.text, source.label, kind);
      if (outcome.ok) parsed.push(outcome.manifest);
      else unreadable.push({ source: outcome.source, message: outcome.message });
    }

    // ── versions ────────────────────────────────────────────────────────────
    const manifestFindings: { source: string; finding: Finding }[] = [];
    for (const manifest of parsed) {
      for (const finding of manifest.findings) {
        manifestFindings.push({ source: manifest.source, finding });
      }
    }

    const known = parsed.filter((m) => m.version !== undefined);
    const distinct = [...new Set(known.map((m) => m.version as string))].sort();
    if (distinct.length > 1) {
      manifestFindings.push({
        source: "*",
        finding: {
          severity: "error",
          code: "versionsDisagree",
          message: `the manifests state different versions: ${known.map((m) => `${m.source}=${m.version}`).join(", ")}`,
        },
      });
    }
    if (input.expectVersion !== undefined) {
      for (const manifest of parsed) {
        if (manifest.version === undefined) continue;
        if (manifest.version !== input.expectVersion) {
          manifestFindings.push({
            source: manifest.source,
            finding: {
              severity: "error",
              code: "versionUnexpected",
              message: `states version ${manifest.version}, but ${input.expectVersion} was expected`,
            },
          });
        }
      }
    }

    // ── assets ──────────────────────────────────────────────────────────────
    const download = input.download ?? true;
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const rows: AssetRow[] = [];
    let bytesDownloaded = 0;
    // Two manifests routinely point at the SAME file — scoop and winget both
    // install the Windows binary — and that binary is tens of megabytes. Each
    // URL is fetched once per call and the outcome is reused, so verifying all
    // four manifests moves the bytes of five assets, not six. Every row still
    // gets its own verdict, because the sha each manifest DECLARES is its own.
    const probes = new Map<string, AssetProbe>();
    const probeOnce = async (url: string): Promise<{ probe: AssetProbe; fresh: boolean }> => {
      const cached = probes.get(url);
      if (cached !== undefined) return { probe: cached, fresh: false };
      const probe = await probeAsset(url, {
        maxBytes,
        timeoutMs,
        ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
      });
      probes.set(url, probe);
      return { probe, fresh: true };
    };

    for (const manifest of parsed) {
      for (const asset of manifest.assets) {
        const flaw = assetUrlFlaw(asset.url);
        if (flaw !== undefined) {
          manifestFindings.push({
            source: manifest.source,
            finding: {
              severity: "error",
              code: flaw.code,
              message: `${asset.label}: ${flaw.message}`,
            },
          });
        }
        // THE VERSION THE FILE CLAIMS AGAINST THE VERSION IT DOWNLOADS. This
        // was computed per row and then only displayed, so a formula whose
        // `version "1.2.4"` line had been bumped while its URLs still pointed
        // at the 1.2.3 binaries came back `verdict: "verified"` — every hash
        // agreed, because each URL really does serve the build it names. That
        // is the exact shape of a half-finished release bump, brew would
        // install 1.2.3 as 1.2.4, and the tool signed it off. It is a definite
        // disagreement inside one file, so it is an error finding.
        // `notFound` stays silent: a "latest" path is unusual, not wrong.
        if (
          manifest.version !== undefined &&
          versionInUrl(asset.url, manifest.version) === "differs"
        ) {
          const named = [...new Set(versionTokensInUrl(asset.url))];
          manifestFindings.push({
            source: manifest.source,
            finding: {
              severity: "error",
              code: "versionUrlMismatch",
              message: `${asset.label}: this manifest states version ${manifest.version}, but the URL it downloads names ${named.map((token) => `"${token}"`).join(", ")} — the bytes may hash correctly and still be the wrong release`,
            },
          });
        }
        const { row, fresh } = await verifyAsset(manifest, asset, { download, probeOnce }, flaw);
        if (fresh && row.bytes !== undefined && row.outcome !== "unchecked") {
          bytesDownloaded += row.bytes;
        }
        rows.push(row);
      }
    }

    // One URL, two manifests, two different checksums: whatever the bytes turn
    // out to be, one of those files is wrong about them. Worth saying on its
    // own, because it is true without downloading anything.
    for (const [url, declared] of groupDeclaredShas(parsed)) {
      if (declared.size > 1) {
        manifestFindings.push({
          source: "*",
          finding: {
            severity: "error",
            code: "shasDisagree",
            message: `${[...declared.values()].join(" and ")} both claim to be the sha256 of ${url} — at most one of those manifests can be right`,
          },
        });
      }
    }

    // ── verdict ─────────────────────────────────────────────────────────────
    const summary = {
      verified: rows.filter((r) => r.outcome === "verified").length,
      mismatched: rows.filter((r) => r.outcome === "mismatch").length,
      missing: rows.filter((r) => r.outcome === "missing").length,
      unchecked: rows.filter((r) => r.outcome === "unchecked").length,
    };
    const errors = manifestFindings.filter((f) => f.finding.severity === "error").length;
    const unknowns = manifestFindings.filter((f) => f.finding.severity === "unknown").length;

    const failed = summary.mismatched > 0 || summary.missing > 0 || errors > 0;
    const incomplete = summary.unchecked > 0 || unknowns > 0 || unreadable.length > 0;
    // A definite failure outranks an unknown — it still says no — but the
    // unknowns are reported either way, because "failed, and four more we
    // could not check" is a different situation from "failed, everything else
    // verified".
    const verdict = failed ? "failed" : incomplete ? "incomplete" : "verified";

    return json({
      verdict,
      headline: headlineFor(verdict, summary, errors, unknowns, unreadable.length),
      ...(input.expectVersion === undefined ? {} : { expectVersion: input.expectVersion }),
      version: distinct.length === 1 ? distinct[0] : undefined,
      downloadsAttempted: download,
      bytesDownloaded,
      summary,
      manifests: parsed.map((manifest) => ({
        source: manifest.source,
        kind: manifest.kind,
        version: manifest.version,
        assets: manifest.assets.length,
      })),
      assets: rows,
      ...(manifestFindings.length > 0
        ? {
            findings: manifestFindings.map((entry) => ({
              source: entry.source,
              severity: entry.finding.severity,
              code: entry.finding.code,
              message: entry.finding.message,
            })),
          }
        : {}),
      ...(unreadable.length > 0 ? { notChecked: unreadable } : {}),
    });
  },
});

/**
 * A defect in the download URL itself, found before anything is dialled.
 *
 * These are errors about the MANIFEST, not outcomes about the asset: a
 * published file that tells installers to fetch over http, or from an address
 * only the release engineer's laptop can reach, is broken whether or not the
 * bytes behind it happen to be right. So each one raises an error finding AND
 * leaves the asset unchecked — it is never fetched, because fetching it could
 * not make the manifest correct.
 */
type AssetUrlFlawCode =
  | "insecureScheme"
  | "privateHost"
  | "urlMalformed"
  | "urlWhitespace"
  | "credentialsInUrl";

type AssetUrlFlaw = { readonly code: AssetUrlFlawCode; readonly message: string };

function assetUrlFlaw(url: string): AssetUrlFlaw | undefined {
  // BEFORE PARSING, because parsing is what hides this one. The URL parser
  // silently DELETES ASCII tab, CR and LF from anywhere in a URL and
  // percent-encodes the other control characters, so `new URL(raw).href` is
  // not the string the file contains. A row that then reports
  // `https://host/crew<TAB>haus-macos-arm64-1.2.3` as verified is naming a URL
  // that was never fetched — the bytes came from the de-tabbed one — and brew
  // or winget, whose own URL handling is not the WHATWG parser's, may resolve
  // it a third way. Comparing the parsed form and publishing the string is the
  // defect class this check closes, so the string has to be a URL literally.
  const control = firstControlChar(url);
  if (control !== undefined) {
    return {
      code: "urlWhitespace",
      message: `this download URL contains ${codePointLabel(control.code)} at offset ${control.index} — the URL parser deletes tabs and line breaks and encodes the other control characters, so the string in this file is not the URL that would be fetched; it was not fetched`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { code: "urlMalformed", message: `"${url}" is not a URL, so nothing could be fetched` };
  }
  if (parsed.protocol !== "https:") {
    return {
      code: "insecureScheme",
      message: `this manifest tells installers to download from "${url}" — anything but https can be rewritten in flight, checksum and all, so it was not fetched`,
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // `PackageManifestGenerate` refuses to WRITE one of these; a published
    // manifest that carries one has to be caught on the way in too. Two
    // reasons, either enough on its own: the credential is published, and
    // `https://github.com@dl.attacker.example/crewhaus-macos-arm64-1.2.3`
    // reads as github.com to every human reviewing the diff while fetching
    // from dl.attacker.example. Dialling it would also hand the credential to
    // that host, so it is not dialled.
    return {
      code: "credentialsInUrl",
      message: `this download URL carries credentials before the "@", so the host it actually fetches from is ${parsed.host} and not what the text in front of the "@" reads as — these files are published, so a credential in one is a published credential; it was not fetched`,
    };
  }
  const privateReason = privateHostReason(parsed.hostname);
  if (privateReason !== undefined) {
    return {
      code: "privateHost",
      message: `this manifest points at ${privateReason} — an installer anywhere else cannot reach it, and a published manifest that names an internal host is a release defect, so it was not fetched`,
    };
  }
  return undefined;
}

type VerifyOptions = {
  readonly download: boolean;
  readonly probeOnce: (url: string) => Promise<{ probe: AssetProbe; fresh: boolean }>;
};

/**
 * The declared sha256 of every URL, per URL, across all the manifests — as a
 * set, so a URL two files agree about collapses to one entry and a URL they
 * disagree about does not.
 */
function groupDeclaredShas(manifests: ReadonlyArray<ParsedManifest>): Map<string, Set<string>> {
  const byUrl = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    for (const asset of manifest.assets) {
      const seen = byUrl.get(asset.url) ?? new Set<string>();
      seen.add(asset.declaredSha256.toLowerCase());
      byUrl.set(asset.url, seen);
    }
  }
  return byUrl;
}

async function verifyAsset(
  manifest: ParsedManifest,
  asset: DeclaredAsset,
  options: VerifyOptions,
  flaw: AssetUrlFlaw | undefined,
): Promise<{ row: AssetRow; fresh: boolean }> {
  const base: AssetRow = {
    manifest: manifest.kind,
    source: manifest.source,
    target: asset.label,
    url: asset.url,
    declaredSha256: asset.declaredSha256,
    outcome: "unchecked",
  };
  if (manifest.version !== undefined) {
    base.versionInUrl = versionInUrl(asset.url, manifest.version);
  }

  if (!/^[0-9a-f]{64}$/i.test(asset.declaredSha256)) {
    // There is nothing to compare against, so fetching the bytes would answer
    // a question nobody can use. The malformed sha is already an error finding
    // from the reader; this row says the download was not checked and why.
    return {
      fresh: false,
      row: {
        ...base,
        reason: "malformedSha",
        message: `the manifest's sha256 for this asset is not 64 hex characters, so there is nothing to compare a download against`,
      },
    };
  }

  if (flaw !== undefined) {
    return { fresh: false, row: { ...base, reason: flaw.code, message: flaw.message } };
  }

  if (!options.download) {
    return {
      fresh: false,
      row: {
        ...base,
        reason: "notRequested",
        message:
          "downloads were turned off, so this asset was not fetched — its sha256 is unconfirmed, not confirmed",
      },
    };
  }

  const { probe, fresh } = await options.probeOnce(asset.url);

  // Where the bytes CAME FROM, when that is not where the manifest pointed.
  // Saying "the bytes at this URL hash to X" after three redirects onto a
  // different host is true of the URL that was dialled last and misleading
  // about the one in the file. `safeLabel` and not the raw final URL: a
  // redirect target routinely carries a signed-URL token in its query, and a
  // release log is not the place to publish one.
  const redirected =
    probe.finalUrl !== undefined && safeLabel(probe.finalUrl) !== safeLabel(asset.url)
      ? safeLabel(probe.finalUrl)
      : undefined;
  const from = redirected === undefined ? {} : { fetchedFrom: redirected };

  if (probe.kind === "missing") {
    return {
      fresh,
      row: { ...base, ...from, outcome: "missing", status: probe.status, message: probe.message },
    };
  }
  if (probe.kind === "unknown") {
    return {
      fresh,
      row: {
        ...base,
        ...from,
        outcome: "unchecked",
        reason: probe.reason,
        message: probe.message,
        ...(probe.status === undefined ? {} : { status: probe.status }),
        ...(probe.bytes === undefined ? {} : { bytes: probe.bytes }),
      },
    };
  }

  const matches = probe.sha256.toLowerCase() === asset.declaredSha256.toLowerCase();
  const via = redirected === undefined ? "" : ` (the download was redirected to ${redirected})`;
  return {
    fresh,
    row: {
      ...base,
      ...from,
      outcome: matches ? "verified" : "mismatch",
      computedSha256: probe.sha256,
      status: probe.status,
      bytes: probe.bytes,
      ...(matches
        ? {}
        : {
            message: `the bytes at this URL hash to ${probe.sha256}, and the manifest claims ${asset.declaredSha256.toLowerCase()} — ${probe.bytes} bytes were read in full, so this is a real disagreement and not a failed download${via}`,
          }),
    },
  };
}

function headlineFor(
  verdict: string,
  summary: { verified: number; mismatched: number; missing: number; unchecked: number },
  errors: number,
  unknowns: number,
  notChecked: number,
): string {
  const parts: string[] = [];
  parts.push(`${summary.verified} verified`);
  if (summary.mismatched > 0) parts.push(`${summary.mismatched} hash mismatch`);
  if (summary.missing > 0) parts.push(`${summary.missing} missing (404)`);
  if (summary.unchecked > 0) parts.push(`${summary.unchecked} not checked`);
  const tail: string[] = [];
  if (errors > 0) tail.push(`${errors} structural error${errors === 1 ? "" : "s"}`);
  if (unknowns > 0)
    tail.push(`${unknowns} check${unknowns === 1 ? "" : "s"} that could not be made`);
  if (notChecked > 0) tail.push(`${notChecked} manifest${notChecked === 1 ? "" : "s"} not read`);
  const suffix = tail.length > 0 ? `; ${tail.join(", ")}` : "";
  switch (verdict) {
    case "verified":
      return summary.verified === 0 && summary.unchecked === 0
        ? "these manifests declare no downloads, and their structural checks passed"
        : `every asset these manifests point at was fetched and hashed, and every hash agreed (${parts.join(", ")})`;
    case "failed":
      return `this release does not check out: ${parts.join(", ")}${suffix}`;
    default:
      return `nothing disagreed, but the check is incomplete: ${parts.join(", ")}${suffix} — an asset that could not be fetched is not an asset that verified`;
  }
}

/** Everything this package registers. */
export const DISTRIBUTION_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  packageManifestGenerate,
  packageManifestVerify,
]);
