/**
 * A browser session over the console, and the one file that knows how sign-in
 * works. A session fails on anything that broke along the way, so a journey can
 * never pass over a page that errored: a console error, a page error, a CSP
 * violation, a failed asset, any 5xx, or the script-execution sentinel.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { settle, trackInFlight } from "./settle";

/** All a session reads from a Home. `session-self-test` aims it at its own server. */
export type HomeAddress = {
  readonly url: string;
  readonly bootPath: string;
  readonly token: string;
};

export type SessionFailureKind =
  | "console-error"
  | "page-error"
  | "csp-violation"
  | "failed-asset"
  | "server-error"
  | "sentinel";

export type SessionFailure = {
  readonly kind: SessionFailureKind;
  readonly route: string;
  readonly reason: string;
};

export type OpenSessionOptions = {
  /** Names the trace file on failure. */
  readonly label?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly reducedMotion?: "reduce" | "no-preference";
  /** The console theme, set before the app reads it. */
  readonly theme?: "dark" | "light";
  /** Sees every response from before sign-in, which a listener added later would miss. */
  readonly onResponse?: (response: Response) => void;
};

export type Session = {
  readonly page: Page;
  readonly context: BrowserContext;
  failures(): readonly SessionFailure[];
  /** Requests and JS modules seen since the session opened. Report only. */
  counts(): { readonly requests: number; readonly jsModules: number };
  /** Go to a hash route and wait for it to settle. */
  visit(route: string): Promise<void>;
  /** Throw, naming every failure with its route and reason, if there are any. */
  assertClean(): void;
  /**
   * Close it. A trace is written if the session recorded a failure or `trace` is
   * `"keep"`. A self-test, whose planted failures are the point, passes `"discard"`.
   */
  close(opts?: { readonly trace?: "keep" | "discard" }): Promise<void>;
};

let browser: Promise<Browser> | undefined;

/** One browser per process, launched on first use. */
export function sharedBrowser(): Promise<Browser> {
  browser ??= (async () => {
    const { chromium } = await import("playwright");
    return chromium.launch();
  })();
  return browser;
}

/** Close the shared browser. The suite calls this when it ends. */
export async function closeSharedBrowser(): Promise<void> {
  if (browser === undefined) return;
  const running = browser;
  browser = undefined;
  await (await running).close();
}

/**
 * Whether a console error is a failure, and why. One thing is not: the
 * browser's "Failed to load resource" for an `/api/*` 404, because 404 is how
 * the client learns something is absent, and absence is not an error. Anything
 * else is, including a 404 for an asset and any other status from the API.
 */
export function consoleErrorReason(text: string, locationUrl: string): string | null {
  let pathname = "";
  try {
    pathname = new URL(locationUrl).pathname;
  } catch {
    // No usable location: nothing to excuse it with.
  }
  const isApi404 =
    text.startsWith("Failed to load resource") &&
    text.includes("status of 404") &&
    pathname.startsWith("/api/");
  return isApi404 ? null : `${text} (${locationUrl})`;
}

const spentBootPaths = new WeakSet<object>();

/**
 * The path that signs a new session in. `bootPath` is one single-use ticket
 * minted at boot, so the first session on a Home spends it and any later one
 * trades the token for its own.
 */
async function signInPath(home: HomeAddress): Promise<string> {
  if (!spentBootPaths.has(home)) {
    spentBootPaths.add(home);
    return home.bootPath;
  }
  const res = await fetch(`${home.url}/api/boot-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${home.token}` },
    keepalive: false,
  });
  if (!res.ok) throw new Error(`minting a sign-in ticket answered ${res.status}`);
  return ((await res.json()) as { bootPath: string }).bootPath;
}

let traceCounter = 0;

/** Open a context, sign in through the real boot path, and wait for it to settle. */
export async function openSession(
  home: HomeAddress,
  opts: OpenSessionOptions = {},
): Promise<Session> {
  const context = await (await sharedBrowser()).newContext({
    ...(opts.viewport !== undefined ? { viewport: opts.viewport } : {}),
    ...(opts.reducedMotion !== undefined ? { reducedMotion: opts.reducedMotion } : {}),
  });
  await context.tracing.start({ snapshots: true, screenshots: false });

  const failures: SessionFailure[] = [];
  let route = "sign-in";
  let closing = false;
  let requests = 0;
  let jsModules = 0;
  const record = (kind: SessionFailureKind, reason: string): void => {
    failures.push({ kind, route, reason });
  };

  await context.exposeBinding("__e2eReportCsp", (_source, reason: string) => {
    record("csp-violation", reason);
  });
  await context.exposeBinding("__e2eReportSentinel", (_source, value: string) => {
    record("sentinel", `globalThis.__e2eSentinel was set to ${value}`);
  });
  await context.addInitScript(() => {
    const report = globalThis as unknown as {
      __e2eReportCsp(reason: string): void;
      __e2eReportSentinel(value: string): void;
    };
    globalThis.addEventListener("securitypolicyviolation", (event) => {
      const violation = event as SecurityPolicyViolationEvent;
      report.__e2eReportCsp(
        `${violation.effectiveDirective} blocked ${violation.blockedURI || "inline content"}`,
      );
    });
    let sentinel: unknown;
    Object.defineProperty(globalThis, "__e2eSentinel", {
      configurable: true,
      get: () => sentinel,
      set: (value: unknown) => {
        sentinel = value;
        report.__e2eReportSentinel(String(value));
      },
    });
  });
  if (opts.theme !== undefined) {
    await context.addInitScript((theme) => {
      try {
        localStorage.setItem("hangar.theme", theme);
      } catch {
        // A page with no storage has no theme to set.
      }
    }, opts.theme);
  }

  const page = await context.newPage();
  trackInFlight(page);
  if (opts.onResponse !== undefined) page.on("response", opts.onResponse);
  page.on("request", (request) => {
    requests += 1;
    if (request.resourceType() === "script") jsModules += 1;
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const reason = consoleErrorReason(message.text(), message.location().url);
    if (reason !== null) record("console-error", reason);
  });
  page.on("pageerror", (error) => {
    record("page-error", error.message);
  });
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    const status = response.status();
    if (status >= 500) record("server-error", `${status} from ${pathname}`);
    else if (pathname.startsWith("/assets/") && (status < 200 || status >= 300)) {
      record("failed-asset", `${status} from ${pathname}`);
    }
  });
  page.on("requestfailed", (request) => {
    if (closing) return;
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/assets/")) {
      record("failed-asset", `${pathname} failed: ${request.failure()?.errorText ?? "unknown"}`);
    }
  });

  await page.goto(`${home.url}${await signInPath(home)}`);
  await settle(page, route);

  const session: Session = {
    page,
    context,
    failures: () => [...failures],
    counts: () => ({ requests, jsModules }),
    visit: async (next) => {
      route = next;
      await page.evaluate((hash) => {
        globalThis.location.hash = hash;
      }, next);
      await settle(page, next);
    },
    assertClean: () => {
      if (failures.length === 0) return;
      const lines = failures.map((f) => `  ${f.kind} on ${f.route}: ${f.reason}`);
      throw new Error(`the session broke:\n${lines.join("\n")}`);
    },
    close: async (closeOpts = {}) => {
      if (closing) return;
      closing = true;
      const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
      const wanted =
        closeOpts.trace === "keep" || (closeOpts.trace !== "discard" && failures.length > 0);
      if (wanted && artifacts !== undefined && artifacts !== "") {
        mkdirSync(artifacts, { recursive: true });
        traceCounter += 1;
        const name = `${opts.label ?? "session"}-${traceCounter}.trace.zip`;
        await context.tracing.stop({ path: join(artifacts, name) });
      } else {
        await context.tracing.stop();
      }
      await context.close();
    },
  };
  return session;
}

/**
 * A page outside `openSession`: nothing is watching it. For the two places where
 * a console error is the designed behaviour, a 401 and a spent boot ticket.
 */
export async function openPlainPage(): Promise<{
  readonly page: Page;
  close(): Promise<void>;
}> {
  const context = await (await sharedBrowser()).newContext();
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await context.close();
    },
  };
}
