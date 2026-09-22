/**
 * The anonymous auth dance, parsed generically.
 *
 * A registry answers an unauthenticated manifest request with 401 and a
 * `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. The
 * client fetches a token from the realm and retries. Docker Hub, ghcr.io and
 * quay.io all differ in the realm host, the service name and whether they echo
 * a scope — which is precisely why this is driven off the challenge instead of
 * a table of registries. A registry we have never heard of works for free; a
 * table would have to be edited every time one appeared.
 *
 * The challenge is data from the server, so it is treated as hostile:
 * the realm must be an absolute https URL with no credentials in it, and the
 * SCOPE WE ASK FOR IS OUR OWN — a challenge that asks us to request
 * `repository:someone/else:push` gets our `repository:<what we asked for>:pull`
 * instead.
 */

export type AuthChallenge = {
  readonly scheme: string;
  readonly params: Readonly<Record<string, string>>;
};

export class AuthChallengeError extends Error {
  override readonly name = "AuthChallengeError";
}

/** RFC 7230 token characters — what an unquoted scheme or auth-param name is made of. */
const TOKEN_CHARS = /[A-Za-z0-9!#$%&'*+\-.^_`|~]/;

/**
 * Parse a `WWW-Authenticate` header into its challenges.
 *
 * The grammar is genuinely ambiguous — `,` separates auth-params AND
 * challenges — so this resolves it the way every HTTP client does: a bare
 * token that is NOT followed by `=` starts the next challenge. That is what
 * makes `Basic realm="x", Bearer realm="y"` (quay.io has shipped this shape)
 * parse as two challenges rather than one Basic with a junk param.
 */
export function parseAuthenticateHeader(header: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  let i = 0;
  const n = header.length;

  const skipSeparators = (): void => {
    while (i < n && (header[i] === " " || header[i] === "\t" || header[i] === ",")) i++;
  };
  const readToken = (): string => {
    const start = i;
    while (i < n && TOKEN_CHARS.test(header[i] as string)) i++;
    return header.slice(start, i);
  };
  const skipSpace = (): void => {
    while (i < n && (header[i] === " " || header[i] === "\t")) i++;
  };
  const readValue = (): string => {
    if (header[i] === '"') {
      i++;
      let out = "";
      while (i < n) {
        const ch = header[i] as string;
        // A quoted-pair escapes the next character verbatim; without this a
        // realm containing an escaped quote truncates the URL.
        if (ch === "\\" && i + 1 < n) {
          out += header[i + 1] as string;
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          return out;
        }
        out += ch;
        i++;
      }
      throw new AuthChallengeError(`unterminated quoted value in WWW-Authenticate: ${header}`);
    }
    return readToken();
  };

  while (i < n) {
    skipSeparators();
    if (i >= n) break;
    const scheme = readToken();
    if (scheme === "") {
      // Nothing token-shaped here: the header is malformed past this point.
      break;
    }
    const params: Record<string, string> = {};
    while (true) {
      const save = i;
      skipSeparators();
      if (i >= n) break;
      const name = readToken();
      if (name === "") {
        i = save;
        break;
      }
      skipSpace();
      if (header[i] !== "=") {
        // A bare token — this is the next challenge's scheme, not our param.
        i = save;
        break;
      }
      i++; // consume "="
      skipSpace();
      params[name.toLowerCase()] = readValue();
    }
    challenges.push({ scheme, params });
    // Guard against a pathological header pinning the loop at one position.
    const before = i;
    skipSeparators();
    if (i === before && i < n && !TOKEN_CHARS.test(header[i] as string)) i++;
  }
  return challenges;
}

/** The Bearer challenge, if the server offered one. Scheme match is case-insensitive. */
export function bearerChallenge(challenges: readonly AuthChallenge[]): AuthChallenge | undefined {
  return challenges.find((c) => c.scheme.toLowerCase() === "bearer");
}

/**
 * Build the token request URL from a challenge.
 *
 * `scope` is ours, not the challenge's. `service` is taken from the challenge
 * because registries genuinely differ (`registry.docker.io` vs `ghcr.io`) and
 * some reject a token request without it — but it is only ever a query
 * parameter, so the worst a hostile value can do is get its own token refused.
 */
export function tokenRequestUrl(challenge: AuthChallenge, scope: string): URL {
  const realm = challenge.params["realm"];
  if (realm === undefined || realm === "") {
    throw new AuthChallengeError(
      "registry asked for Bearer auth but the challenge has no realm — nothing to fetch a token from",
    );
  }
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    throw new AuthChallengeError(`auth realm "${realm}" is not an absolute URL`);
  }
  if (url.protocol !== "https:") {
    // A token fetched over plaintext can be swapped by anyone on the path, and
    // a `file:`/`gopher:` realm is an outright attack on the client.
    throw new AuthChallengeError(
      `auth realm "${realm}" is not https — refusing to fetch a token over ${url.protocol.replace(":", "")}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new AuthChallengeError(
      `auth realm "${realm}" carries credentials — refusing; these tools are anonymous-only`,
    );
  }
  const service = challenge.params["service"];
  if (service !== undefined && service !== "") url.searchParams.set("service", service);
  url.searchParams.set("scope", scope);
  return url;
}

/**
 * Pull the bearer token out of a token endpoint's JSON body. Registries are
 * inconsistent: the distribution spec says `token`, OAuth2 says `access_token`,
 * and ghcr.io returns both. Parsing here is safe — a token is not content
 * addressed, so nothing downstream hashes these bytes.
 */
export function readTokenBody(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuthChallengeError("token endpoint did not return JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AuthChallengeError("token endpoint returned JSON that is not an object");
  }
  const body = parsed as Record<string, unknown>;
  const token = body["token"] ?? body["access_token"];
  if (typeof token !== "string" || token === "") {
    throw new AuthChallengeError(
      "token endpoint returned no token — the repository is probably private, and these tools are anonymous-only",
    );
  }
  return token;
}
