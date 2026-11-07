/**
 * The addresses a process is really listening on, asked of the operating
 * system. A test that fetches the address it bound cannot tell loopback from a
 * wildcard; these commands can.
 */

/** `host` out of `host:port`, with an IPv6 address's brackets gone. */
function hostOf(endpoint: string): string {
  const colon = endpoint.lastIndexOf(":");
  const host = colon === -1 ? endpoint : endpoint.slice(0, colon);
  return host.replace(/^\[|\]$/g, "");
}

const unique = (hosts: readonly string[]): string[] => [...new Set(hosts)].sort();

/** The listeners on `port` in `lsof -nP -a -p <pid> -iTCP:<port> -sTCP:LISTEN -Fn` output. */
export function parseLsofListeners(output: string, port: number): string[] {
  const suffix = `:${port}`;
  return unique(
    output
      .split("\n")
      .filter((line) => line.startsWith("n") && line.endsWith(suffix))
      .map((line) => hostOf(line.slice(1))),
  );
}

/** The listeners `pid` holds on `port` in `ss -ltnp` output. */
export function parseSsListeners(output: string, pid: number, port: number): string[] {
  const suffix = `:${port}`;
  const owner = `pid=${pid},`;
  const hosts: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes(owner)) continue;
    const local = line.trim().split(/\s+/)[3];
    if (local?.endsWith(suffix) === true) hosts.push(hostOf(local));
  }
  return unique(hosts);
}

function run(argv: readonly string[]): string | undefined {
  try {
    const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every address `pid` listens on at `port`. `undefined` means could not
 * determine: the command is missing, failed, or does not show this listener.
 * That is not "nothing is listening", so every caller fails on it.
 */
export function listeningAddresses(pid: number, port: number): string[] | undefined {
  let hosts: string[] | undefined;
  if (process.platform === "darwin") {
    const argv = ["lsof", "-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"];
    const output = run(argv);
    hosts = output === undefined ? undefined : parseLsofListeners(output, port);
  } else if (process.platform === "linux") {
    const output = run(["ss", "-ltnp"]);
    hosts = output === undefined ? undefined : parseSsListeners(output, pid, port);
  }
  return hosts === undefined || hosts.length === 0 ? undefined : hosts;
}
