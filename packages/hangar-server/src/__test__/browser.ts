/**
 * A browser, for tests: it signs in the way the console does, with the console's own
 * modules (`sealed.js`, `sign-in.js`) loaded by URL, against a live Home. Not compiled
 * into anything; tests import it directly.
 */

export type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string };
export type Seal = { seal: Jwk; open(issued: unknown, op: string): Promise<string> };

type SealedJs = { makeSeal(): Promise<Seal> };
type SignInJs = {
  makeDeviceKey(): Promise<{ privateKey: CryptoKey; deviceJwk: Jwk }>;
  signChallenge(
    key: CryptoKey,
    input: { device: string; nonce: string; seal: Jwk },
  ): Promise<string>;
};

export async function sealedJs(): Promise<SealedJs> {
  return (await import(
    new URL("../../../hangar-ui/assets/js/sealed.js", import.meta.url).href
  )) as SealedJs;
}

export async function signInJs(): Promise<SignInJs> {
  return (await import(
    new URL("../../../hangar-ui/assets/js/sign-in.js", import.meta.url).href
  )) as SignInJs;
}

/** Fetch a path on one Home, with no credential unless the init carries one. */
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export const bearer = (secret: string): Record<string, string> => ({
  authorization: `Bearer ${secret}`,
});

/** Spend a boot link: the one-time code its redirect carries. */
export async function codeFrom(fetchRaw: Fetcher, bootPath: string): Promise<string> {
  const res = await fetchRaw(bootPath, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const match = /^\/#x=([A-Za-z0-9_-]+)$/.exec(location);
  if (res.status !== 302 || match?.[1] === undefined) {
    throw new Error(`the boot link answered ${res.status} ${location}`);
  }
  return match[1];
}

export type Browser = {
  /** The current session secret. */
  session: string;
  readonly device: string;
  readonly privateKey: CryptoKey;
};

async function post(
  fetchRaw: Fetcher,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetchRaw(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Trade a code for a session, with a new device key: what a browser does at `#x=`. */
export async function exchange(
  fetchRaw: Fetcher,
  code: string,
): Promise<Browser & { answer: Record<string, unknown> }> {
  const key = await (await signInJs()).makeDeviceKey();
  const seal = await (await sealedJs()).makeSeal();
  const res = await post(fetchRaw, "/api/v1/auth/exchange", {
    code,
    deviceJwk: key.deviceJwk,
    seal: seal.seal,
  });
  const answer = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200)
    throw new Error(`exchange answered ${res.status} ${JSON.stringify(answer)}`);
  return {
    session: await seal.open(answer["issued"], "auth.exchange"),
    device: answer["device"] as string,
    privateKey: key.privateKey,
    answer,
  };
}

/** Sign a browser in from a boot link. */
export async function signInFromBootLink(fetchRaw: Fetcher, bootPath: string): Promise<Browser> {
  const { answer: _answer, ...browser } = await exchange(
    fetchRaw,
    await codeFrom(fetchRaw, bootPath),
  );
  return browser;
}

/** A returning browser: challenge, sign, session. Answers the response, and the secret on 200. */
export async function returning(
  fetchRaw: Fetcher,
  browser: Pick<Browser, "device" | "privateKey">,
): Promise<{ status: number; body: Record<string, unknown>; session?: string }> {
  const challenge = (await (await fetchRaw("/api/v1/auth/challenge")).json()) as { nonce: string };
  const seal = await (await sealedJs()).makeSeal();
  const signature = await (await signInJs()).signChallenge(browser.privateKey, {
    device: browser.device,
    nonce: challenge.nonce,
    seal: seal.seal,
  });
  const res = await post(fetchRaw, "/api/v1/auth/session", {
    device: browser.device,
    nonce: challenge.nonce,
    signature,
    seal: seal.seal,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return res.status === 200
    ? { status: res.status, body, session: await seal.open(body["issued"], "auth.session") }
    : { status: res.status, body };
}

/** Refresh a session: answers the new secret. */
export async function refresh(fetchRaw: Fetcher, session: string): Promise<string> {
  const seal = await (await sealedJs()).makeSeal();
  const res = await post(fetchRaw, "/api/v1/auth/refresh", { seal: seal.seal }, bearer(session));
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`refresh answered ${res.status} ${JSON.stringify(body)}`);
  return seal.open(body["issued"], "auth.refresh");
}

/** Join Home from an invite the way the console does where it can make keys. */
export async function acceptInvite(
  fetchRaw: Fetcher,
  code: string,
  displayName: string,
): Promise<Browser & { answer: Record<string, unknown> }> {
  const key = await (await signInJs()).makeDeviceKey();
  const seal = await (await sealedJs()).makeSeal();
  const res = await post(fetchRaw, "/api/v1/auth/accept-invite", {
    code,
    displayName,
    deviceJwk: key.deviceJwk,
    seal: seal.seal,
  });
  const answer = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(`accept-invite answered ${res.status} ${JSON.stringify(answer)}`);
  }
  return {
    session: await seal.open(answer["issued"], "auth.acceptInvite"),
    device: answer["device"] as string,
    privateKey: key.privateKey,
    answer,
  };
}

/** Join Home from an invite the way a page that is not encrypted does: a secret it made. */
export async function acceptInviteTabOnly(
  fetchRaw: Fetcher,
  code: string,
  displayName: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; session: string }> {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const res = await post(
    fetchRaw,
    "/api/v1/auth/accept-invite",
    { code, displayName, sessionSecret: secret },
    headers,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    session: `cha_${secret}`,
  };
}
