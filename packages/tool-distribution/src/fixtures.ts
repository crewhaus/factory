/**
 * Recorded release assets, the manifests that point at them, and a fetch stub
 * that serves them.
 *
 * Nothing in this package's suite opens a socket or resolves a name: every
 * test installs `_setFetch` and `_setDnsLookup`, so the whole download path
 * runs against these bytes. A test that reached a real release host would fail
 * on a CI runner with no egress and would start failing for everyone the day
 * somebody deleted a tag.
 *
 * The assets are tiny, which is the only thing about them that is unrealistic;
 * the hashes are computed from the bytes here rather than written down, so a
 * fixture edit moves the expected sha with it instead of breaking a test in a
 * way that reads like a hash mismatch.
 */
import { createHash } from "node:crypto";
import type { ManifestInputs } from "@crewhaus/single-binary-cli";
import type { DistributionFetch } from "./lib/net";

const encoder = new TextEncoder();
export const bytesOf = (text: string): Uint8Array => encoder.encode(text);
export const sha256Of = (input: Uint8Array | string): string =>
  createHash("sha256")
    .update(typeof input === "string" ? encoder.encode(input) : input)
    .digest("hex");

export const VERSION = "1.2.3";
export const HOMEPAGE = "https://crewhaus.ai";
export const DOWNLOAD_BASE = "https://github.com/crewhaus/factory/releases/download/v1.2.3";

export const TARGETS = [
  "macos-arm64",
  "macos-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;
export type Target = (typeof TARGETS)[number];

/** Stand-ins for the ~80 MB binaries, one distinct body per target. */
export const ASSET_BYTES: Readonly<Record<Target, Uint8Array>> = Object.freeze({
  "macos-arm64": bytesOf("#!/crewhaus\nmacos arm64 build of 1.2.3\n"),
  "macos-x64": bytesOf("#!/crewhaus\nmacos x64 build of 1.2.3\n"),
  "linux-arm64": bytesOf("#!/crewhaus\nlinux arm64 build of 1.2.3\n"),
  "linux-x64": bytesOf("#!/crewhaus\nlinux x64 build of 1.2.3\n"),
  "windows-x64": bytesOf("MZcrewhaus windows x64 build of 1.2.3\n"),
});

export const ASSET_SHAS: Readonly<Record<Target, string>> = Object.freeze(
  Object.fromEntries(TARGETS.map((target) => [target, sha256Of(ASSET_BYTES[target])])) as Record<
    Target,
    string
  >,
);

/**
 * The sha map minus one target.
 *
 * A helper rather than `delete map[target]` at each call site: the lint rules
 * here ban `delete`, and its automatic fix is `map[target] = undefined`, which
 * is NOT the same thing — the key is still there, and a test meaning "this
 * target was never supplied" would silently become "this target was supplied
 * as undefined".
 */
export function withoutTarget(
  map: Readonly<Record<string, string>>,
  target: string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== target));
}

/** Where each asset lives, exactly as the renderers spell it. */
export function assetUrl(target: Target, version: string = VERSION): string {
  const name = `crewhaus-${target}-${version}${target.startsWith("windows") ? ".exe" : ""}`;
  return `${DOWNLOAD_BASE.replace(VERSION, version)}/${name}`;
}

export const RELEASE: ManifestInputs = Object.freeze({
  version: VERSION,
  homepage: HOMEPAGE,
  downloadBaseUrl: DOWNLOAD_BASE,
  sha256: ASSET_SHAS,
});

// ─── the fetch stub ─────────────────────────────────────────────────────────

export type Route = {
  readonly status?: number;
  readonly body?: Uint8Array | string | null;
  readonly headers?: Readonly<Record<string, string>>;
  /** Deliver the body in slices of this many bytes, as a real stream would. */
  readonly chunk?: number;
  /** Never answer; resolve only when the caller's deadline aborts the request. */
  readonly hang?: boolean;
  /** Fail the way a socket does, before any response exists. */
  readonly throws?: string;
};

export type Call = { readonly url: string; readonly pinnedIp: string };

export type Stub = {
  readonly fetch: DistributionFetch;
  readonly calls: Call[];
};

/**
 * The default every suite installs in `beforeEach`.
 *
 * A test that forgets its own stub would otherwise fall through to the real
 * dialler and reach the internet — which on a runner with no egress fails as a
 * five-second TIMEOUT, i.e. as the one outcome this package is careful to keep
 * separate from everything else. This turns that mistake into an immediate,
 * unmistakable error instead. It cost a round here already.
 */
export const forbidNetwork: DistributionFetch = async (req) => {
  throw new Error(
    `a test tried to reach ${req.url} — install stubFetch({...}) before calling anything that downloads`,
  );
};

/**
 * A fetch that answers from a URL → route table. An unlisted URL answers 404,
 * because that is what a release host does for an asset that was never
 * uploaded — the case `PackageManifestVerify` has to call "missing" rather
 * than "could not check".
 */
export function stubFetch(routes: Readonly<Record<string, Route>>): Stub {
  const calls: Call[] = [];
  const fetch: DistributionFetch = async (req, pinnedIp) => {
    // A real fetch rejects immediately on an already-aborted signal. The stub
    // has to as well, or a cancellation test passes against a stub that would
    // never behave that way in production.
    if (req.signal.aborted) {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }
    calls.push({ url: req.url, pinnedIp });
    const route = routes[req.url];
    if (route === undefined) {
      return new Response("not found", { status: 404 });
    }
    if (route.throws !== undefined) {
      throw new Error(route.throws);
    }
    if (route.hang === true) {
      return await new Promise<Response>((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        };
        if (req.signal.aborted) fail();
        else req.signal.addEventListener("abort", fail, { once: true });
      });
    }
    const status = route.status ?? 200;
    const headers = new Headers(route.headers ?? {});
    const body = route.body === undefined ? new Uint8Array(0) : route.body;
    if (body === null) {
      return new Response(null, { status, headers });
    }
    const bytes = typeof body === "string" ? bytesOf(body) : body;
    if (route.chunk === undefined) {
      return new Response(bytes, { status, headers });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += route.chunk as number) {
          controller.enqueue(bytes.slice(offset, offset + (route.chunk as number)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status, headers });
  };
  return { fetch, calls };
}

/** The happy path: every asset of the 1.2.3 release, served whole. */
export function releaseRoutes(
  overrides: Readonly<Record<string, Route>> = {},
): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const target of TARGETS) {
    routes[assetUrl(target)] = { body: ASSET_BYTES[target] };
  }
  return { ...routes, ...overrides };
}

// ─── manifests that are not the renderer's output ───────────────────────────

/**
 * A formula with a url and no sha256 after it — what a hand-edit looks like,
 * and the one thing a formula must never contain: Homebrew would download and
 * install that binary without checking it against anything.
 */
export const FORMULA_URL_WITHOUT_SHA = `class Crewhaus < Formula
  desc "Modular meta-harness"
  homepage "https://crewhaus.ai"
  version "1.2.3"
  license "Apache-2.0"

  on_macos do
    url "${assetUrl("macos-arm64")}"
  end

  on_linux do
    url "${assetUrl("linux-x64")}"
    sha256 "${ASSET_SHAS["linux-x64"]}"
  end
end
`;

/** A control paragraph whose second description line lost its leading space. */
export const CONTROL_LOST_SPACE = `Package: crewhaus
Version: 1.2.3
Section: utils
Priority: optional
Architecture: any
Maintainer: CrewHaus Maintainers <maintainers@crewhaus.ai>
Depends: libc6 (>= 2.31)
Description: Modular meta-harness
 the first continuation line is fine
the second one is not
`;

/** The double-space case: the caller indented text the renderer indents too. */
export const CONTROL_DOUBLE_INDENTED = `Package: crewhaus
Version: 1.2.3
Section: utils
Priority: optional
Architecture: any
Maintainer: CrewHaus Maintainers <maintainers@crewhaus.ai>
Depends: libc6 (>= 2.31)
Description: Modular meta-harness
  this line arrived already carrying its space
`;

/** Scoop's other shape: url and hash at the top level, no architecture map. */
export const SCOOP_TOP_LEVEL = JSON.stringify(
  {
    version: VERSION,
    description: "Modular meta-harness",
    homepage: HOMEPAGE,
    license: "Apache-2.0",
    url: assetUrl("windows-x64"),
    hash: ASSET_SHAS["windows-x64"],
    bin: "crewhaus.exe",
  },
  null,
  2,
);

/** Two urls, one hash: scoop pairs them by position, so one is unverified. */
export const SCOOP_UNPAIRED = JSON.stringify(
  {
    version: VERSION,
    architecture: {
      "64bit": {
        url: [assetUrl("windows-x64"), `${DOWNLOAD_BASE}/crewhaus-extra-1.2.3.exe`],
        hash: [ASSET_SHAS["windows-x64"]],
      },
    },
    bin: "crewhaus.exe",
  },
  null,
  2,
);
