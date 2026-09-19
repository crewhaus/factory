/**
 * What to do with a URI a contract handed back — which is to say, mostly
 * nothing.
 *
 * `tokenURI()` returns a string chosen by whoever deployed the contract. A
 * tool that fetches it because a contract said so is a server-side request
 * forgery with extra steps: the "token id" is the attacker's, the URL is the
 * attacker's, and the request comes from inside whatever network the harness
 * runs in. So the default here is to fetch NOTHING over the network, and
 * every URI is classified into a plan the answer reports in full — what was
 * read, what was skipped, and why.
 *
 * Three things are readable without trusting the contract with a socket:
 *
 *   - `data:` URIs, which are decoded in-process. A great many NFTs are
 *     entirely on-chain and this is the whole of their metadata.
 *   - `ipfs://`, but only through a gateway the CALLER named. The rewritten
 *     URL is checked to still be inside that gateway afterwards, because
 *     `ipfs:////evil.example/x` otherwise resolves to somebody else's origin.
 *   - `https://`, but only to a host the CALLER allow-listed.
 *
 * Everything else — `http://`, `ar://`, an empty string, a gateway that was
 * never supplied — is skipped with the reason attached.
 *
 * Like the chain seam, there is no dialling code here: `_setMetadataFetch` is
 * the only way a byte arrives, the runtime binds it, and the tests drive it.
 */
import { Buffer } from "node:buffer";

export type MetadataResponse = {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
};

export type MetadataFetch = (req: {
  readonly url: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}) => Promise<MetadataResponse>;

const unbound: MetadataFetch = async (req) => {
  throw new Error(
    `no metadata fetcher is bound, so ${req.url} was not read. This package contains no HTTP client of its own: the runtime binds one with _setMetadataFetch(), which is also where redirect, SSRF and timeout policy belongs.`,
  );
};

let metadataFetch: MetadataFetch = unbound;

/** Bind the metadata fetcher. `undefined` restores the unbound state. */
export function _setMetadataFetch(fn: MetadataFetch | undefined): void {
  metadataFetch = fn ?? unbound;
}

export function hasMetadataFetch(): boolean {
  return metadataFetch !== unbound;
}

/** 256 KiB. Metadata is a small JSON document; anything larger is not one. */
export const DEFAULT_MAX_METADATA_BYTES = 256 * 1024;

export type UriPlan =
  | { readonly action: "inline"; readonly scheme: "data"; readonly mediaType: string }
  | {
      readonly action: "fetch";
      readonly scheme: "ipfs" | "https";
      /** The URL that would actually be requested, after any rewrite. */
      readonly url: string;
    }
  | { readonly action: "skip"; readonly scheme: string; readonly reason: string };

export type UriPolicy = {
  /** A URL PREFIX such as "https://cloudflare-ipfs.com/ipfs/". Nothing is guessed. */
  readonly ipfsGateway?: string;
  /** Hosts an https URI may be fetched from. Exact host match, case-insensitive. */
  readonly allowedHosts?: ReadonlyArray<string>;
};

function schemeOf(uri: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri.trim());
  return match === null ? "" : (match[1] as string).toLowerCase();
}

/**
 * Check a caller-supplied gateway before anything is joined onto it. A
 * gateway carrying a query string or missing its trailing slash silently
 * produces a different URL than the caller intends.
 */
export function checkIpfsGateway(gateway: string): string {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new Error(`the ipfs gateway "${gateway}" is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error("an ipfs gateway must be https");
  if (url.search !== "" || url.hash !== "") {
    throw new Error("an ipfs gateway must not carry a query string or a fragment");
  }
  if (!gateway.endsWith("/")) {
    throw new Error(
      `the ipfs gateway must end with "/" — it is a prefix the CID is joined onto, e.g. https://example.org/ipfs/`,
    );
  }
  return gateway;
}

/** Decide what, if anything, may be done with one URI. Decides; does not act. */
export function planUri(rawUri: string, policy: UriPolicy): UriPlan {
  const uri = rawUri.trim();
  if (uri === "") return { action: "skip", scheme: "", reason: "the contract returned no URI" };
  const scheme = schemeOf(uri);

  if (scheme === "data") {
    const comma = uri.indexOf(",");
    if (comma === -1) {
      return { action: "skip", scheme: "data", reason: "a data: URI with no comma has no payload" };
    }
    const header = uri.slice("data:".length, comma);
    const mediaType = header.split(";")[0] ?? "";
    return {
      action: "inline",
      scheme: "data",
      mediaType: mediaType === "" ? "text/plain" : mediaType,
    };
  }

  if (scheme === "ipfs") {
    if (policy.ipfsGateway === undefined) {
      return {
        action: "skip",
        scheme: "ipfs",
        reason: "no ipfsGateway was supplied, and this package will not pick one for you",
      };
    }
    const gateway = checkIpfsGateway(policy.ipfsGateway);
    // Both `ipfs://<cid>/…` and the `ipfs://ipfs/<cid>/…` form some contracts
    // emit; the gateway prefix already ends in /ipfs/, so the duplicate
    // segment has to come off or the path is wrong.
    let rest = uri.slice("ipfs://".length);
    if (rest.startsWith("ipfs/")) rest = rest.slice("ipfs/".length);
    rest = rest.replace(/^\/+/, "");
    if (rest === "") {
      return { action: "skip", scheme: "ipfs", reason: "the ipfs URI has no CID" };
    }
    let joined: string;
    try {
      joined = new URL(rest, gateway).href;
    } catch {
      return { action: "skip", scheme: "ipfs", reason: `"${uri}" does not join onto the gateway` };
    }
    // The contract chose `rest`. `//evil.example/x` and `../..` both escape a
    // naive concatenation, so the result is checked to still be inside the
    // gateway the caller named.
    if (!joined.startsWith(gateway)) {
      return {
        action: "skip",
        scheme: "ipfs",
        reason: `the URI resolves to ${joined}, outside the gateway prefix it was given — refusing to follow a contract off its own gateway`,
      };
    }
    return { action: "fetch", scheme: "ipfs", url: joined };
  }

  if (scheme === "https") {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return { action: "skip", scheme: "https", reason: "not a URL" };
    }
    const allowed = (policy.allowedHosts ?? []).map((h) => h.toLowerCase());
    if (!allowed.includes(url.hostname.toLowerCase())) {
      return {
        action: "skip",
        scheme: "https",
        reason:
          allowed.length === 0
            ? "https metadata is not fetched unless the caller allow-lists the host; a URL that came out of contract data is not a reason to dial it"
            : `${url.hostname} is not in allowedHosts (${allowed.join(", ")})`,
      };
    }
    return { action: "fetch", scheme: "https", url: url.href };
  }

  if (scheme === "http") {
    return {
      action: "skip",
      scheme: "http",
      reason:
        "plaintext http is never fetched — the answer would be whatever the network says it is",
    };
  }

  return {
    action: "skip",
    scheme,
    reason: scheme === "" ? "the URI has no scheme" : `${scheme}: is not a scheme this reads`,
  };
}

/** Decode a `data:` URI's payload in-process. */
export function decodeDataUri(uri: string, maxBytes: number): Uint8Array {
  const comma = uri.indexOf(",");
  const header = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);
  const bytes = /;base64$/i.test(header)
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : new TextEncoder().encode(decodeURIComponent(payload));
  if (bytes.length > maxBytes) {
    throw new Error(`the data: URI holds ${bytes.length} bytes, over the ${maxBytes}-byte cap`);
  }
  return bytes;
}

export type FetchedDocument = {
  readonly bytes: Uint8Array;
  readonly status: number;
  readonly contentType: string | null;
};

/** Fetch through the seam, then enforce the cap on what actually came back. */
export async function fetchDocument(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<FetchedDocument> {
  const response = await metadataFetch(
    signal === undefined ? { url, maxBytes } : { url, maxBytes, signal },
  );
  if (response.bytes.length > maxBytes) {
    // The cap is re-checked here rather than trusted to the injected fetcher,
    // because the cap is this package's promise and the fetcher is somebody
    // else's code.
    throw new Error(
      `${url} returned ${response.bytes.length} bytes, over the ${maxBytes}-byte cap — refusing to parse it`,
    );
  }
  return { bytes: response.bytes, status: response.status, contentType: response.contentType };
}

/** A URL a metadata document points at. Reported, never followed. */
export type ReferencedUrl = {
  readonly field: string;
  readonly scheme: string;
  readonly value: string;
};

const REFERENCE_FIELDS = ["image", "image_url", "image_data", "animation_url", "external_url"];

/**
 * The URLs inside a metadata document, listed so the caller knows they exist.
 *
 * None of them is fetched. An image URL is the same third-party string the
 * tokenURI was, one level deeper, and following it would undo the whole
 * policy above.
 */
export function referencedUrls(metadata: unknown): ReadonlyArray<ReferencedUrl> {
  if (typeof metadata !== "object" || metadata === null) return [];
  const record = metadata as Record<string, unknown>;
  const out: ReferencedUrl[] = [];
  for (const field of REFERENCE_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value === "") continue;
    out.push({ field, scheme: schemeOf(value), value: value.slice(0, 512) });
  }
  return out;
}
