/**
 * Home's listeners beyond its TCP port.
 *
 *   - `<hangarRoot>/home.sock`: Home's own socket. Only the OS user who owns the Hangar
 *     root can open it (mode 0600, inside the 0700 root), so it accepts Home's own key
 *     whatever else is configured; the CLI talks to Home through it.
 *   - `<hangarRoot>/proxy.sock`: in trusted-proxy mode with `socket: true`, the proxy's
 *     socket, whose file mode is the proof that a request came from the proxy.
 *   - A loopback listener at the same port when Home is bound to a LAN address or a named
 *     host, so a browser on Home's own computer still has a secure context to sign in
 *     from (a plain-HTTP LAN address is not one, and WebCrypto exists only in one).
 *
 * Windows has no unix sockets here: neither socket is created there.
 */
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME_SOCKET, PROXY_SOCKET, isLoopbackAddress } from "@crewhaus/access-control";

export { HOME_SOCKET, PROXY_SOCKET };

/** Whether sockets are created on this platform. */
export function socketsSupported(platform: string = process.platform): boolean {
  return platform !== "win32";
}

/** `localhost` or a loopback address. */
export function isLoopbackHostname(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare.toLowerCase() === "localhost" || isLoopbackAddress(bare);
}

/** `0.0.0.0` or `::`: every interface, loopback included. */
export function isWildcardHostname(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
}

export function socketPath(hangarRoot: string, name: string): string {
  return join(hangarRoot, name);
}

/** What is at `path`: nothing, a socket, or something else. */
function entryAt(path: string): "absent" | "socket" | "other" {
  try {
    return lstatSync(path).isSocket() ? "socket" : "other";
  } catch {
    return "absent";
  }
}

/** Remove the socket at `path`; anything that is not a socket is left alone. */
export function unlinkSocket(path: string): void {
  if (entryAt(path) !== "socket") return;
  try {
    unlinkSync(path);
  } catch {
    // Gone already.
  }
}

/**
 * Bind a unix socket at `path` through `serve`: a stale socket there is replaced, a file
 * that is not a socket is never touched (the bind is skipped, with a warning), and the
 * socket is made 0600 once bound. Answers the server, or `undefined` when it could not
 * be bound.
 *
 * First consumer: `startHangarServer`.
 */
export function bindSocket<T extends { stop(closeActive?: boolean): unknown }>(
  path: string,
  serve: (path: string) => T,
  onWarn: (message: string) => void,
): T | undefined {
  const there = entryAt(path);
  if (there === "other") {
    onWarn(
      `hangar-server: ${path} exists and is not a socket — it was left alone, so Home has no socket there`,
    );
    return undefined;
  }
  if (there === "socket") unlinkSocket(path);
  let server: T;
  try {
    server = serve(path);
  } catch (err) {
    onWarn(
      `hangar-server: could not listen on ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    void server.stop(true);
    unlinkSocket(path);
    onWarn(
      `hangar-server: could not restrict ${path} to its owner: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return server;
}
