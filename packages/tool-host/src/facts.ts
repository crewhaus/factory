import { getServers } from "node:dns";
/**
 * The two seams that are not commands: what the runtime itself knows about
 * the machine (`node:os`, `node:dns`, `process`), and the filesystem reads
 * that stand in for commands on Linux (`/proc`, `/sys`, `/etc`).
 *
 * Both are injectable for the same reason the command runner is: this
 * package is developed on macOS and tested on Linux, and a fact read from
 * the test machine is a fact the test cannot assert. With these two seams a
 * test can put the code on a Windows host with eight cores and no battery
 * without owning one.
 *
 * `node:os` is not trusted blindly. Three of its answers are zeros that are
 * not measurements, and each one is exactly the defect this package exists
 * to avoid:
 *
 *   - `os.cpus()` returns an EMPTY ARRAY in some containers and on some
 *     Linux kernels where /proc is restricted. Reported verbatim that is
 *     "0 cores", which a caller gates on.
 *   - `os.loadavg()` returns `[0, 0, 0]` on Windows — documented, and not a
 *     load measurement at all.
 *   - `os.freemem()` is free memory, never available memory. On Linux the
 *     number a caller wants is MemAvailable, which is typically several
 *     times larger; on macOS there is no equivalent figure at all.
 *
 * So the raw facts are carried here and interpreted in `lib/system.ts`,
 * where each of those cases becomes `null` plus a stated reason.
 */
import { readFileSync, readdirSync, statfsSync } from "node:fs";
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  networkInterfaces,
  platform,
  release,
  totalmem,
  type,
  uptime,
  version,
} from "node:os";

/** One entry of `os.networkInterfaces()`, narrowed to what is used. */
export type OsInterfaceAddress = {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
  readonly mac?: string;
  readonly netmask?: string;
  readonly cidr?: string | null;
  readonly scopeid?: number;
};

/**
 * The runtime's own view of the host. Every field is a raw reading — the
 * interpretation (and the nulls) happen downstream.
 */
export type HostFacts = {
  readonly platform: NodeJS.Platform | string;
  readonly arch: string;
  /** `os.release()` — the kernel release, not the product version. */
  readonly release: string;
  /** `os.type()` — "Darwin", "Linux", "Windows_NT". */
  readonly type: string;
  /** `os.version()` — the kernel version string. */
  readonly version: string;
  readonly hostname: string;
  readonly uptimeSeconds: number;
  readonly totalMemBytes: number;
  readonly freeMemBytes: number;
  /** May legitimately be empty; see the header. */
  readonly cpus: ReadonlyArray<{ readonly model: string; readonly speed: number }>;
  /** May legitimately be `[0,0,0]` on Windows; see the header. */
  readonly loadAverage: readonly [number, number, number];
  /** `undefined` on Windows, where there are no uids. */
  readonly uid: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dnsServers: ReadonlyArray<string>;
  readonly interfaces: Readonly<Record<string, ReadonlyArray<OsInterfaceAddress> | undefined>>;
  readonly runtime: { readonly name: string; readonly version: string };
};

function readRealFacts(): HostFacts {
  let dnsServers: ReadonlyArray<string> = [];
  try {
    dnsServers = getServers();
  } catch {
    // Node throws if the resolver is not initialised; an empty list here is
    // turned into "unknown", not into "no resolvers".
  }
  const load = loadavg();
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    type: type(),
    version: version(),
    hostname: hostname(),
    uptimeSeconds: uptime(),
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    cpus: cpus().map((c) => ({ model: c.model, speed: c.speed })),
    loadAverage: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    env: process.env,
    dnsServers,
    interfaces: networkInterfaces() as Readonly<
      Record<string, ReadonlyArray<OsInterfaceAddress> | undefined>
    >,
    runtime:
      typeof Bun === "undefined"
        ? { name: "node", version: process.versions.node }
        : { name: "bun", version: Bun.version },
  };
}

let factsOverride: HostFacts | undefined;

/**
 * Replace the runtime's view of the host.
 *
 * The WHOLE object is required rather than a partial, and that is the point:
 * a partial merged over the real readings would leave the unstated fields
 * pointing at the machine running the test. A test that describes a Windows
 * host would then inherit CI's Linux interface table and pass for the wrong
 * reason. Every fact a test depends on has to be stated.
 *
 * Passing `undefined` restores the real readings.
 */
export function _setHostFacts(facts: HostFacts | undefined): void {
  factsOverride = facts;
}

export function hostFacts(): HostFacts {
  return factsOverride ?? readRealFacts();
}

/** What `fs.statfsSync` returns, narrowed to the fields that are used. */
export type StatfsReading = {
  readonly bsize: number;
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
};

/**
 * Filesystem access, as one seam.
 *
 * `readText` returns `undefined` rather than throwing, because every caller
 * here treats "could not read it" as a fact to report rather than an error
 * to raise — /proc/meminfo is absent on macOS and that is not a failure.
 * `listDir` is sorted by the default implementation: readdir order is not
 * defined, and a tool whose output depends on it is not deterministic.
 */
export type HostFs = {
  readText(path: string): string | undefined;
  listDir(path: string): ReadonlyArray<string> | undefined;
  statfs(path: string): StatfsReading | undefined;
};

const realFs: HostFs = {
  readText(path) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return undefined;
    }
  },
  listDir(path) {
    try {
      return [...readdirSync(path)].sort();
    } catch {
      return undefined;
    }
  },
  statfs(path) {
    try {
      const s = statfsSync(path);
      return {
        bsize: Number(s.bsize),
        blocks: Number(s.blocks),
        bfree: Number(s.bfree),
        bavail: Number(s.bavail),
      };
    } catch {
      // statfs is missing on old runtimes and fails on some network mounts.
      return undefined;
    }
  },
};

let fsOverride: HostFs | undefined;

/**
 * Replace filesystem access — all three functions, for the same reason
 * `_setHostFacts` takes a whole object. CI is Linux, so leaving `readText`
 * real would let a test about a macOS host read CI's actual /proc/cpuinfo
 * and agree with it.
 *
 * `undefined` restores the real implementation.
 */
export function _setFs(fs: HostFs | undefined): void {
  fsOverride = fs;
}

export function hostFs(): HostFs {
  return fsOverride ?? realFs;
}
