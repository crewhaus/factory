/**
 * @crewhaus/tool-host — what this machine is, as facts a workflow can gate
 * on.
 *
 * Three read-only questions: what the machine IS (`SystemInfo`), how it is
 * attached to the network (`NetworkInfo`), and what is listening on it
 * (`PortInspect`). Nothing here changes anything, nothing here reaches off
 * the host — not even a TCP probe of a public address, which the survey
 * sketch proposed and which `@crewhaus/tool-proc`'s `WaitForPort` already
 * covers for the cases where reaching out is the point.
 *
 * Two rules run through all of it.
 *
 * 1. **Unknown is an answer; zero is not.** Every probe can be missing,
 *    refused or silent, and each of those produces `null` plus an entry in
 *    the result's `unknown` list naming the probe and the reason. A count is
 *    never defaulted to 0, a flag never to false, a list never to empty.
 *    "0 CPUs", "no network interfaces" and "port 631 is free" are answers a
 *    caller acts on, and each one is a lie when the truth is that the probe
 *    did not run. The convention in the output is exact: `null` means
 *    unknown and is always explained; an ABSENT key means not applicable
 *    (no battery has no charge level; an unset proxy variable has no value).
 *
 * 2. **No argv is ever built.** Every command this package can run is a
 *    frozen literal in `HOST_COMMANDS`. Caller input filters parsed results
 *    in JavaScript and never becomes an argument, so `{ports:["-rf"]}` is a
 *    schema error rather than a flag, and there is no shell anywhere for a
 *    metacharacter to reach. This repo has shipped argument injection once
 *    (`gitBranchCreate({name:"-D"})` ran `git branch -D victim`); the cure
 *    used here is having nothing to inject INTO.
 *
 * Both rules are tested rather than asserted: `every null is explained`
 * walks each result, and `argv is a constant` replays adversarial input
 * against a recording runner.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type HostFacts, hostFacts, hostFs } from "./facts";
import {
  type HostInterface,
  interfacesFromOsMap,
  parseIfconfig,
  parseIpAddrText,
  parseIpJson,
  parseResolvConf,
  proxyFromEnv,
} from "./lib/network";
import {
  type ListenSocket,
  type LsofRecord,
  dedupeSockets,
  familyOf,
  joinOwners,
  looksLikeNetstatOutput,
  looksLikeProcNetTcp,
  looksLikeSsOutput,
  looksLikeWindowsNetstatOutput,
  parseBsdNetstat,
  parseLinuxNetstat,
  parseLsofColumns,
  parseLsofFields,
  parseProcNetTcp,
  parseSsListen,
  parseTasklistCsv,
  parseWindowsNetstat,
  sortSockets,
} from "./lib/ports";
import {
  type BatteryFacts,
  chooseSystemBattery,
  pairValue,
  parseColonPairs,
  parseEqualsPairs,
  parsePmsetBatt,
  parseProcCpuinfo,
  parseProcMeminfo,
  parseSwVers,
  parseSysfsBattery,
  parseUname,
  parseWmicBattery,
  statfsToBytes,
} from "./lib/system";
import { type UnknownFact, Unknowns, failureReason } from "./lib/unknown";
import { ToolPermissionError, resolveSafe } from "./paths";
import { HOST_COMMANDS, runHostCommand } from "./run";

export { _setRunner, HOST_COMMANDS, ALL_HOST_COMMANDS, hostSpawnEnv } from "./run";
export { _setFs, _setHostFacts } from "./facts";
export type { HostFacts, HostFs, StatfsReading } from "./facts";
export * from "./lib/system";
export * from "./lib/network";
export * from "./lib/ports";
export { Unknowns, type UnknownFact } from "./lib/unknown";

/** Compact JSON — the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_COMMAND_TIMEOUT_MS = 60_000;
/** How many sockets a single PortInspect returns before it says it stopped. */
const DEFAULT_SOCKET_LIMIT = 200;

const timeoutField = z
  .number()
  .int()
  .min(100)
  .max(MAX_COMMAND_TIMEOUT_MS)
  .optional()
  .describe(
    `milliseconds allowed to EACH probe command (default ${DEFAULT_COMMAND_TIMEOUT_MS}); a probe that exceeds it is reported as unknown, not as zero`,
  );

type ProbeResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** stdout hit the runner's cap: what is here is a PREFIX of the answer. */
  readonly truncated: boolean;
  /** The command as written, for the `unknown` entries. */
  readonly label: string;
  readonly reason: string;
};

async function probe(
  argv: ReadonlyArray<string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProbeResult> {
  const outcome = await runHostCommand(argv, {
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  const label = argv.join(" ");
  const base = {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    truncated: outcome.stdoutTruncated === true,
    label,
  };
  if (outcome.ok) return { ...base, ok: true, reason: "" };
  const { reason } = failureReason(outcome.failure, outcome.stderr);
  return { ...base, ok: false, reason };
}

/** Drop keys whose value is `undefined`, so "not applicable" is an absent
 *  key while "unknown" stays an explicit null. */
function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SystemInfo
// ---------------------------------------------------------------------------

const SECTIONS = ["os", "cpu", "memory", "uptime", "runtime", "battery", "disk"] as const;
/** Everything that costs at most one cheap command. Battery shells out and
 *  disk needs a path, so both are opt-in. */
const DEFAULT_SECTIONS = ["os", "cpu", "memory", "uptime", "runtime"] as const;

/**
 * /proc/cpuinfo, or null when it cannot be read.
 *
 * It records no unknowns of its own: which fields are actually missing is
 * only clear after the runtime's own readings have been merged in, and an
 * entry added here would claim the model is unknown on a host where
 * `os.cpus()` already named it.
 */
function readLinuxCpuinfo(): ReturnType<typeof parseProcCpuinfo> | null {
  const text = hostFs().readText("/proc/cpuinfo");
  return text === undefined ? null : parseProcCpuinfo(text);
}

async function collectOs(
  facts: HostFacts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  unknown: Unknowns,
): Promise<Record<string, unknown>> {
  const kernel: Record<string, unknown> = {
    name: facts.type,
    release: facts.release,
    version: facts.version,
    machine: facts.arch,
  };

  // uname exists on every POSIX host and nowhere on Windows; asking for it
  // there would report "not installed" as if something were wrong.
  if (facts.platform !== "win32") {
    const uname = await probe(HOST_COMMANDS.uname, timeoutMs, signal);
    if (uname.ok) {
      const parsed = parseUname(uname.stdout);
      if (parsed !== null) {
        kernel["name"] = parsed.kernelName;
        kernel["release"] = parsed.kernelRelease;
        kernel["version"] = parsed.kernelVersion;
        kernel["machine"] = parsed.machine;
      }
    }
    // Not an unknown: node:os answered the same four fields already, and
    // uname is only the more precise source. The kernel facts are never null.
  }

  let distro: Record<string, unknown> | null = null;
  if (facts.platform === "darwin") {
    const swVers = await probe(HOST_COMMANDS.swVers, timeoutMs, signal);
    if (swVers.ok) {
      const parsed = parseSwVers(swVers.stdout);
      distro = compact({
        name: parsed.productName,
        version: parsed.productVersion,
        build: parsed.buildVersion,
      });
    } else {
      unknown.add("os.distro", swVers.label, swVers.reason);
    }
  } else if (facts.platform === "win32") {
    // Everything that names a Windows edition (systeminfo, Get-CimInstance)
    // is either localized free text or needs PowerShell, and this package
    // runs no shell. The build number from node:os is reported instead.
    unknown.add(
      "os.distro",
      "node:os",
      "Windows has no non-PowerShell probe for the product name; kernel.release carries the build number",
    );
  } else {
    const text = hostFs().readText("/etc/os-release") ?? hostFs().readText("/usr/lib/os-release");
    if (text === undefined) {
      unknown.add("os.distro", "/etc/os-release", "the file could not be read on this host");
    } else {
      const pairs = parseEqualsPairs(text);
      distro = compact({
        name: pairs.get("NAME"),
        version: pairs.get("VERSION_ID"),
        pretty: pairs.get("PRETTY_NAME"),
        id: pairs.get("ID"),
      });
    }
  }

  // A probe that ran and named nothing leaves `{}` behind, which reads as a
  // distro with no name rather than as a probe that said nothing. Null, with
  // the reason, is the honest shape — the same rule as an empty interface
  // list a few functions down.
  if (distro !== null && Object.keys(distro).length === 0) {
    distro = null;
    unknown.add(
      "os.distro",
      facts.platform === "darwin" ? HOST_COMMANDS.swVers.join(" ") : "/etc/os-release",
      "the probe answered, but nothing in its output named the operating system",
    );
  }

  if (facts.hostname === "") {
    unknown.add("os.hostname", "node:os hostname()", "the runtime reported no hostname");
  }
  return compact({
    platform: facts.platform,
    arch: facts.arch,
    hostname: facts.hostname === "" ? null : facts.hostname,
    kernel,
    ...(distro === null ? { distro: null } : { distro }),
  });
}

async function collectCpu(
  facts: HostFacts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  unknown: Unknowns,
): Promise<Record<string, unknown>> {
  let logical: number | null = facts.cpus.length > 0 ? facts.cpus.length : null;
  let physical: number | null = null;
  let model: string | null = facts.cpus[0]?.model?.trim() || null;

  // os.cpus() really does return [] on some container runtimes — the headline
  // case for this package, since read verbatim it is "0 cores". Note it and
  // try the platform probe; only if THAT is also silent is the count unknown.
  // Recording the unknown here instead would contradict the count that the
  // second probe then supplied.
  const runtimeSawNoCpus = logical === null;

  if (facts.platform === "darwin") {
    const sysctl = await probe(HOST_COMMANDS.sysctl, timeoutMs, signal);
    // Parsed even when sysctl exited non-zero: it exits 1 if ANY key it was
    // given is unknown to the kernel, while still printing every key it does
    // know. Discarding the whole answer over one missing key would report an
    // Apple Silicon Mac as having an unknown core count.
    const pairs = parseColonPairs(sysctl.stdout);
    const asCount = (key: string): number | null => {
      const raw = pairValue(pairs, key);
      if (raw === null) return null;
      const value = Number.parseInt(raw, 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    };
    logical = logical ?? asCount("hw.logicalcpu");
    physical = asCount("hw.physicalcpu");
    model = model ?? pairValue(pairs, "machdep.cpu.brand_string");
    if (physical === null) {
      unknown.add(
        "cpu.physicalCores",
        sysctl.label,
        sysctl.ok ? "the kernel did not report hw.physicalcpu" : sysctl.reason,
      );
    }
  } else if (facts.platform === "win32") {
    unknown.add(
      "cpu.physicalCores",
      "node:os",
      "Windows exposes the physical core count only through WMI/PowerShell, which this package does not run",
    );
  } else {
    const cpuinfo = readLinuxCpuinfo();
    if (cpuinfo !== null) {
      logical = logical ?? cpuinfo.logicalCores;
      physical = cpuinfo.physicalCores;
      model = model ?? cpuinfo.model;
      if (cpuinfo.physicalCores === null) {
        unknown.add(
          "cpu.physicalCores",
          "/proc/cpuinfo",
          "the file carries no physical id / core id lines, which every ARM kernel omits; logical cores are NOT a substitute where SMT is on",
        );
      }
    } else {
      unknown.add("cpu.physicalCores", "/proc/cpuinfo", "the file could not be read on this host");
    }
  }

  if (logical === null) {
    unknown.add(
      "cpu.logicalCores",
      runtimeSawNoCpus ? "node:os cpus(), and the platform probe" : "node:os cpus()",
      "the runtime listed no CPUs — which happens in restricted containers — and no other probe answered either",
    );
  }
  if (model === null) {
    unknown.add(
      "cpu.model",
      facts.platform === "linux" ? "/proc/cpuinfo, node:os cpus()" : "node:os cpus()",
      facts.platform === "linux"
        ? "no probe named the CPU; an ARM kernel prints no model name in /proc/cpuinfo at all"
        : "no probe named the CPU",
    );
  }

  // os.loadavg() is documented to return [0,0,0] on Windows. Reporting that
  // verbatim says "the machine is idle" about a machine that may be pinned.
  let loadAverage: readonly number[] | null = facts.loadAverage;
  if (facts.platform === "win32") {
    loadAverage = null;
    unknown.add(
      "cpu.loadAverage",
      "node:os loadavg()",
      "Windows has no load average; the runtime returns [0,0,0], which is not a measurement",
    );
  }

  return { model, logicalCores: logical, physicalCores: physical, loadAverage };
}

async function collectMemory(
  facts: HostFacts,
  unknown: Unknowns,
): Promise<Record<string, unknown>> {
  let total: number | null = facts.totalMemBytes > 0 ? facts.totalMemBytes : null;
  let free: number | null = facts.freeMemBytes > 0 ? facts.freeMemBytes : null;
  let available: number | null = null;

  if (facts.platform === "linux") {
    const text = hostFs().readText("/proc/meminfo");
    if (text === undefined) {
      unknown.add(
        "memory.availableBytes",
        "/proc/meminfo",
        "the file could not be read, and MemAvailable has no substitute",
      );
    } else {
      const parsed = parseProcMeminfo(text);
      total = total ?? parsed.totalBytes;
      free = parsed.freeBytes ?? free;
      available = parsed.availableBytes;
      if (available === null) {
        unknown.add(
          "memory.availableBytes",
          "/proc/meminfo",
          "MemAvailable is absent (kernels before 3.14); MemFree is NOT the same number and is not substituted",
        );
      }
    }
  } else if (facts.platform === "win32") {
    // os.freemem() on Windows is GlobalMemoryStatusEx's ullAvailPhys, which
    // is available memory rather than free memory — the opposite of the
    // POSIX meaning, so it is reported in the field that means it.
    available = free;
    free = null;
    unknown.add(
      "memory.freeBytes",
      "node:os freemem()",
      "Windows reports AVAILABLE physical memory, not free; the figure is reported as availableBytes",
    );
    if (available === null) {
      // freemem() answered 0, which is not a measurement of anything: the
      // number moved into availableBytes is then a null that would go out
      // with nothing to explain it.
      unknown.add(
        "memory.availableBytes",
        "node:os freemem()",
        "the runtime reported no available memory, and Windows has no other probe here that this package will run",
      );
    }
  } else {
    unknown.add(
      "memory.availableBytes",
      "node:os freemem()",
      "macOS and BSD publish no available-memory figure; free pages alone understate what is reclaimable, so no number is invented",
    );
  }

  if (total === null)
    unknown.add("memory.totalBytes", "node:os totalmem()", "the runtime reported no total memory");
  if (free === null && facts.platform !== "win32") {
    unknown.add("memory.freeBytes", "node:os freemem()", "the runtime reported no free memory");
  }
  return { totalBytes: total, freeBytes: free, availableBytes: available };
}

async function collectBattery(
  facts: HostFacts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  unknown: Unknowns,
): Promise<Record<string, unknown>> {
  let battery: BatteryFacts = { present: null, percent: null, charging: null, powerSource: null };
  let probeLabel = "";

  if (facts.platform === "darwin") {
    const pmset = await probe(HOST_COMMANDS.pmset, timeoutMs, signal);
    probeLabel = pmset.label;
    if (pmset.ok) battery = parsePmsetBatt(pmset.stdout);
    else unknown.add("battery.present", pmset.label, pmset.reason);
  } else if (facts.platform === "win32") {
    const wmic = await probe(HOST_COMMANDS.wmicBattery, timeoutMs, signal);
    probeLabel = wmic.label;
    if (wmic.ok) battery = parseWmicBattery(wmic.stdout);
    else
      unknown.add(
        "battery.present",
        wmic.label,
        `${wmic.reason} (wmic was removed in Windows 11 24H2; the replacement needs PowerShell, which this package does not run)`,
      );
  } else {
    probeLabel = "/sys/class/power_supply";
    const entries = hostFs().listDir("/sys/class/power_supply");
    if (entries === undefined) {
      unknown.add(
        "battery.present",
        probeLabel,
        "the directory could not be listed, so the absence of a battery could not be distinguished from the absence of the probe",
      );
    } else {
      // Chosen by the kernel's own `type`/`scope` attributes rather than by
      // the device's name: that directory also lists a wireless mouse's
      // cell as `hidpp_battery_0`, and a name match reports a desktop as
      // running on battery at the charge of a mouse.
      const bat = chooseSystemBattery(entries, (device, attribute) =>
        hostFs().readText(`/sys/class/power_supply/${device}/${attribute}`),
      );
      if (bat === null) {
        // The directory listed and holds no system battery: a measurement.
        battery = { present: false, percent: null, charging: null, powerSource: null };
      } else {
        probeLabel = `/sys/class/power_supply/${bat}`;
        battery = parseSysfsBattery(
          hostFs().readText(`/sys/class/power_supply/${bat}/capacity`),
          hostFs().readText(`/sys/class/power_supply/${bat}/status`),
        );
        if (battery.present === null) {
          // The device is there and neither of its two files could be read
          // (a permission, a driver that went away mid-read). Without this
          // the tool answers `present: null` with nothing to explain it —
          // the one shape this package promises never to emit.
          unknown.add(
            "battery.present",
            probeLabel,
            "the battery device is listed but neither its capacity nor its status file could be read, so its state is unknown",
          );
        }
      }
    }
  }

  if (battery.present === false) {
    // No battery: charge and charging state are not applicable, so their
    // keys are absent rather than null. A null would claim "unknown".
    return compact({ present: false, powerSource: battery.powerSource ?? undefined });
  }
  if (battery.present === null) {
    // Whether there is a battery at all is unknown, so the charge level is
    // not a separate unknown — it is a question that cannot be asked yet.
    // One null, one reason, no fabricated companions.
    return { present: null };
  }
  if (battery.percent === null) {
    unknown.add("battery.percent", probeLabel, "the probe reported a battery but no charge level");
  }
  if (battery.charging === null) {
    unknown.add(
      "battery.charging",
      probeLabel,
      "the probe reported a state that does not say whether the battery is charging (for example 'Not charging' under a charge limiter)",
    );
  }
  if (battery.powerSource === null) {
    unknown.add("battery.powerSource", probeLabel, "the probe did not name the power source");
  }
  return {
    present: true,
    percent: battery.percent,
    charging: battery.charging,
    powerSource: battery.powerSource,
  };
}

function collectDisk(path: string, unknown: Unknowns): Record<string, unknown> | string {
  let resolved: string;
  try {
    // The path is caller-supplied, so it goes through the same containment
    // resolver the rest of the monorepo uses: lexical check, then the real
    // path, with a dangling symlink followed by hand rather than mistaken
    // for a missing file.
    resolved = resolveSafe("SystemInfo", path).real;
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return `[SystemInfo error] refused path "${path}": it resolves outside the workspace root.`;
    }
    throw err;
  }
  const reading = hostFs().statfs(resolved);
  const disk = statfsToBytes(reading);
  if (reading === undefined) {
    unknown.add(
      "disk.totalBytes",
      `statfs(${path})`,
      "statfs failed for this path; it may not exist, or the filesystem may not support it",
    );
    unknown.add("disk.freeBytes", `statfs(${path})`, "statfs failed for this path");
    unknown.add("disk.availableBytes", `statfs(${path})`, "statfs failed for this path");
  } else {
    // statfs ANSWERED, and a field is still null: `statfsToBytes` refuses a
    // non-positive block size or count, and a negative free/available count
    // — which a filesystem really does report when the root-reserved pool is
    // overdrawn, and which statfsSync returns on APFS. Each of those is a
    // reading that could not be used, so each gets its entry; without them
    // the caller sees a bare null on the one field it was told to gate on.
    const refused =
      "statfs answered with a block count this tool will not report (non-positive size or a negative count), so no byte figure is derived from it";
    if (disk.totalBytes === null) unknown.add("disk.totalBytes", `statfs(${path})`, refused);
    if (disk.freeBytes === null) unknown.add("disk.freeBytes", `statfs(${path})`, refused);
    if (disk.availableBytes === null)
      unknown.add("disk.availableBytes", `statfs(${path})`, refused);
  }
  return {
    path,
    totalBytes: disk.totalBytes,
    freeBytes: disk.freeBytes,
    // Gate on THIS one: freeBytes counts blocks reserved for root that an
    // ordinary process cannot use.
    availableBytes: disk.availableBytes,
  };
}

export const systemInfo: RegisteredTool = buildTool({
  name: "SystemInfo",
  operativeArgs: [],
  description:
    "Report what this machine is — os and kernel, cpu count and model, memory, uptime, runtime version, and on request battery and free disk space. Use it to gate a heavy step on real capacity instead of guessing. Anything a probe could not establish comes back as null with the probe and the reason in `unknown`; a missing battery is never 0% and an unreadable cpu list is never 0 cores.",
  inputSchema: z.object({
    sections: z
      .array(z.enum(SECTIONS))
      .max(SECTIONS.length)
      .optional()
      .describe(
        `which sections to collect (default ${DEFAULT_SECTIONS.join(", ")}); "battery" runs one extra command and "disk" needs diskPath`,
      ),
    diskPath: z
      .string()
      .max(4096)
      .optional()
      .describe(
        "path whose filesystem to measure, inside the workspace root; implies the disk section",
      ),
    timeoutMs: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const facts = hostFacts();
    const unknown = new Unknowns();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const signal = ctx?.signal;
    const wanted = new Set<string>(input.sections ?? DEFAULT_SECTIONS);
    if (input.diskPath !== undefined) wanted.add("disk");
    if (wanted.has("disk") && input.diskPath === undefined) {
      return '[SystemInfo error] the disk section needs diskPath — a path whose filesystem to measure (e.g. ".").';
    }

    const result: Record<string, unknown> = {};
    if (wanted.has("os")) result["os"] = await collectOs(facts, timeoutMs, signal, unknown);
    if (wanted.has("cpu")) result["cpu"] = await collectCpu(facts, timeoutMs, signal, unknown);
    if (wanted.has("memory")) result["memory"] = await collectMemory(facts, unknown);
    if (wanted.has("uptime")) {
      const uptime = facts.uptimeSeconds;
      if (uptime > 0) result["uptimeSeconds"] = Math.round(uptime);
      else {
        result["uptimeSeconds"] = null;
        unknown.add("uptimeSeconds", "node:os uptime()", "the runtime reported no uptime");
      }
    }
    if (wanted.has("runtime")) {
      result["runtime"] = { name: facts.runtime.name, version: facts.runtime.version };
    }
    if (wanted.has("battery")) {
      result["battery"] = await collectBattery(facts, timeoutMs, signal, unknown);
    }
    if (wanted.has("disk")) {
      const disk = collectDisk(input.diskPath as string, unknown);
      if (typeof disk === "string") return disk;
      result["disk"] = disk;
    }
    result["unknown"] = unknown.list();
    return json(result);
  },
});

// ---------------------------------------------------------------------------
// NetworkInfo
// ---------------------------------------------------------------------------

const NETWORK_SECTIONS = ["interfaces", "dns", "proxy"] as const;

/**
 * How one interface is rendered.
 *
 * A field a command does NOT print for an interface is absent rather than
 * null: BSD prints no `status:` line for loopback or for a tunnel, because
 * they have no carrier to report, and a null there would claim the carrier
 * state is unknown. Null is reserved for the runtime's own interface table,
 * which is missing the MTU and the flags for EVERY interface — a genuine
 * unknown, and one the `unknown` list explains.
 */
function renderInterface(iface: HostInterface, keepNulls: boolean): Record<string, unknown> {
  const addresses = iface.addresses.map((address) =>
    compact({
      family: address.family,
      address: address.address,
      prefixLength: address.prefixLength ?? undefined,
      scope: address.scope ?? undefined,
      zone: address.zone,
    }),
  );
  if (keepNulls) {
    return {
      name: iface.name,
      adminUp: iface.adminUp,
      link: iface.link,
      loopback: iface.loopback,
      mtu: iface.mtu,
      mac: iface.mac,
      addresses,
    };
  }
  return compact({
    name: iface.name,
    adminUp: iface.adminUp ?? undefined,
    link: iface.link ?? undefined,
    loopback: iface.loopback ?? undefined,
    mtu: iface.mtu ?? undefined,
    mac: iface.mac ?? undefined,
    addresses,
  });
}

type InterfaceReading = {
  readonly interfaces: HostInterface[] | null;
  readonly source: string | null;
  /** True when the runtime's own table answered, which is the weak source
   *  whose missing fields are reported as unknown. */
  readonly fromRuntimeTable: boolean;
};

async function readInterfaces(
  facts: HostFacts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  unknown: Unknowns,
): Promise<InterfaceReading> {
  const attempts: string[] = [];
  /**
   * Zero interfaces is not an answer, so a command that produced none is
   * recorded as a command that was not understood and the ladder carries on.
   *
   * Every host has at least a loopback interface — an empty parse therefore
   * says the OUTPUT was not what the parser expects, not that the machine
   * has no network. The case is live rather than theoretical: `parseIfconfig`
   * reads the BSD `en0: flags=8863<...> mtu 1500` form, while busybox and
   * net-tools print `eth0      Link encap:Ethernet  HWaddr ...` with no
   * `flags=` anywhere — and busybox is the userland of the slim containers
   * this package's own Linux fixtures came from. Reported verbatim that was
   * `interfaces: []` with an empty `unknown`: a machine with no network.
   */
  const understood = (parsed: HostInterface[] | null): parsed is HostInterface[] =>
    parsed !== null && parsed.length > 0;
  const unparsed = "the command ran but no interface could be parsed from its output";

  if (facts.platform === "linux") {
    // JSON first where a tool emits it: no columns, no hex netmask, no
    // locale. `-j` is not everywhere, though — busybox `ip` answers it with
    // its usage text and exit 1 — so the text parser below stays live.
    const ipJson = await probe(HOST_COMMANDS.ipJson, timeoutMs, signal);
    if (ipJson.ok) {
      const parsed = parseIpJson(ipJson.stdout);
      if (understood(parsed))
        return { interfaces: parsed, source: ipJson.label, fromRuntimeTable: false };
      attempts.push(
        `${ipJson.label} (${parsed === null ? "output was not the expected JSON array" : unparsed})`,
      );
    } else {
      attempts.push(`${ipJson.label} (${ipJson.reason})`);
    }
    const ipText = await probe(HOST_COMMANDS.ipText, timeoutMs, signal);
    if (ipText.ok) {
      const parsed = parseIpAddrText(ipText.stdout);
      if (understood(parsed))
        return { interfaces: parsed, source: ipText.label, fromRuntimeTable: false };
      attempts.push(`${ipText.label} (${unparsed})`);
    } else {
      attempts.push(`${ipText.label} (${ipText.reason})`);
    }
  }

  if (facts.platform !== "win32") {
    const ifconfig = await probe(HOST_COMMANDS.ifconfig, timeoutMs, signal);
    if (ifconfig.ok) {
      const parsed = parseIfconfig(ifconfig.stdout);
      if (understood(parsed))
        return { interfaces: parsed, source: ifconfig.label, fromRuntimeTable: false };
      attempts.push(
        `${ifconfig.label} (${unparsed}; busybox and net-tools print a format this parser does not read)`,
      );
    } else {
      attempts.push(`${ifconfig.label} (${ifconfig.reason})`);
    }
  }

  // The runtime's own table is the floor. It is weaker — no MTU, no flags,
  // and an interface that is down is missing entirely — and the result says
  // so rather than presenting it as a full inventory.
  const fromOs = interfacesFromOsMap(facts.interfaces);
  if (fromOs.length > 0) {
    unknown.add(
      "interfaces[].mtu",
      "node:os networkInterfaces()",
      "the runtime's interface table carries no MTU and no flags, and omits interfaces that are down entirely, so this list may be incomplete",
    );
    unknown.add(
      "interfaces[].adminUp",
      "node:os networkInterfaces()",
      "the runtime's interface table carries no flags",
    );
    unknown.add(
      "interfaces[].link",
      "node:os networkInterfaces()",
      "the runtime's interface table carries no carrier state",
    );
    if (fromOs.some((iface) => iface.mac === null)) {
      // Rendered from this source the three fields above are null for every
      // row, and `mac` joins them whenever the runtime omitted one (it does
      // for some virtual adapters). A null has to be explained wherever it
      // comes from, so this one is conditional rather than absent.
      unknown.add(
        "interfaces[].mac",
        "node:os networkInterfaces()",
        "the runtime's interface table gave no hardware address for at least one interface, and no command answered to supply it",
      );
    }
    if (facts.platform === "win32") {
      attempts.push(
        "ipconfig /all (not parsed: its output is localized and has no machine-readable form)",
      );
    }
    return { interfaces: fromOs, source: "node:os networkInterfaces()", fromRuntimeTable: true };
  }

  unknown.add(
    "interfaces",
    attempts.length > 0 ? attempts.join("; ") : "node:os networkInterfaces()",
    "no interface probe answered, so it is unknown what interfaces exist — this is NOT a machine with no network",
  );
  return { interfaces: null, source: null, fromRuntimeTable: false };
}

function readDns(facts: HostFacts, unknown: Unknowns): Record<string, unknown> {
  const fromRuntime = [...facts.dnsServers];
  const resolvConf = hostFs().readText("/etc/resolv.conf");
  const parsed = resolvConf === undefined ? null : parseResolvConf(resolvConf);

  let resolvers: string[] | null = fromRuntime;
  let source = "node:dns getServers()";
  if (fromRuntime.length === 0) {
    // getServers() answers with an empty list both when nothing is
    // configured and when it could not read the configuration. resolv.conf
    // decides which; when it cannot be read either, the answer is unknown
    // rather than "this machine has no resolvers".
    if (parsed !== null && parsed.resolvers.length > 0) {
      resolvers = [...parsed.resolvers];
      source = "/etc/resolv.conf";
    } else if (parsed !== null) {
      resolvers = [];
      source = "/etc/resolv.conf";
    } else {
      resolvers = null;
      unknown.add(
        "dns.resolvers",
        "node:dns getServers(), /etc/resolv.conf",
        "the runtime listed no resolvers and the configuration file could not be read, so an unconfigured resolver cannot be told apart from an unreadable one",
      );
    }
  }

  let searchDomains: string[] | null = null;
  if (parsed !== null) searchDomains = [...parsed.searchDomains];
  else {
    unknown.add(
      "dns.searchDomains",
      "/etc/resolv.conf",
      facts.platform === "win32"
        ? "Windows has no resolv.conf and the search list is only in the registry, which this package does not read"
        : "the file could not be read",
    );
  }

  return { resolvers, searchDomains, source };
}

export const networkInfo: RegisteredTool = buildTool({
  name: "NetworkInfo",
  operativeArgs: [],
  description:
    "Report how this machine is attached to the network: its interfaces with addresses, MTU and carrier state, the DNS resolvers and search domains in effect, and the proxy environment with any credentials redacted. Use it to explain a connectivity problem from the host's own configuration. It opens no connection and resolves no name; anything a probe could not establish is null with a reason, never an empty interface list.",
  inputSchema: z.object({
    sections: z
      .array(z.enum(NETWORK_SECTIONS))
      .max(NETWORK_SECTIONS.length)
      .optional()
      .describe("which sections to collect (default: all three)"),
    interfaceName: z
      .string()
      .max(64)
      .optional()
      .describe(
        "keep only the interface with this exact name; the filter is applied to the parsed list and never reaches a command line",
      ),
    timeoutMs: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const facts = hostFacts();
    const unknown = new Unknowns();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const wanted = new Set<string>(input.sections ?? NETWORK_SECTIONS);
    const result: Record<string, unknown> = {};

    if (wanted.has("interfaces")) {
      const reading = await readInterfaces(facts, timeoutMs, ctx?.signal, unknown);
      const list =
        reading.interfaces === null
          ? null
          : input.interfaceName === undefined
            ? reading.interfaces
            : // The filter runs over the PARSED list. It is never appended to
              // `ifconfig`/`ip` as an argument, so `{interfaceName:"-a"}` is a
              // name that matches nothing rather than a flag.
              reading.interfaces.filter((i) => i.name === input.interfaceName);
      result["interfaces"] =
        list === null ? null : list.map((i) => renderInterface(i, reading.fromRuntimeTable));
      // Absent rather than null when nothing answered: the unknown entry for
      // `interfaces` already names every probe that was tried.
      if (reading.source !== null) result["interfaceSource"] = reading.source;
    }
    if (wanted.has("dns")) result["dns"] = readDns(facts, unknown);
    if (wanted.has("proxy")) {
      const proxy = proxyFromEnv(facts.env);
      result["proxy"] = compact({
        // An unset variable is not an unknown: the environment was readable
        // and the variable is not there, so the key is absent.
        http: proxy.http ?? undefined,
        https: proxy.https ?? undefined,
        all: proxy.all ?? undefined,
        noProxy: proxy.noProxy ?? undefined,
        configured:
          proxy.http !== null || proxy.https !== null || proxy.all !== null ? undefined : false,
        ...(proxy.conflicts.length > 0 ? { conflicts: proxy.conflicts } : {}),
      });
    }
    result["unknown"] = unknown.list();
    return json(result);
  },
});

// ---------------------------------------------------------------------------
// PortInspect
// ---------------------------------------------------------------------------

/**
 * How one socket is rendered.
 *
 * An owner field the source does not carry is ABSENT: `ss` names a process
 * but no user, /proc/net/tcp carries a uid and neither a pid nor a name.
 * What a caller needs to act on is `ownerKnown`, which is false whenever the
 * owning process could not be read — and the socket is still here, which is
 * the point. Dropping it would turn "held by a process you may not inspect"
 * into "free".
 */
function renderSocket(socket: ListenSocket): Record<string, unknown> {
  return {
    address: socket.address,
    port: socket.port,
    family: socket.family,
    owners: socket.owners.map((owner) =>
      compact({
        pid: owner.pid ?? undefined,
        process: owner.process ?? undefined,
        user: owner.user ?? undefined,
        uid: owner.uid ?? undefined,
      }),
    ),
    ownerKnown: socket.ownerKnown,
  };
}

type SocketReading = {
  readonly sockets: ListenSocket[] | null;
  /** Whether the socket source sees every user's sockets or only this
   *  user's. Decides whether "nothing is listening" may be claimed. */
  readonly coverage: "all-users" | "self-only" | null;
  readonly sources: Array<Record<string, unknown>>;
  readonly ownerCoverage: "all" | "self-only" | "none";
};

async function readSockets(
  facts: HostFacts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  unknown: Unknowns,
): Promise<SocketReading> {
  const sources: Array<Record<string, unknown>> = [];
  const isRoot = facts.uid === 0;

  /** A command that ran and whose output this package could not read. It is
   *  NOT "nothing is listening": the ladder moves on to the next source. */
  const UNPARSED =
    "the command ran but its output was not in the form this parser reads, so nothing could be learned from it";

  /**
   * The coverage a source may claim, given that its output may have been cut.
   *
   * A truncated enumeration is a PREFIX of the socket table, and the cap is
   * reachable: `netstat -an -p tcp` and `netstat -ano` list every socket in
   * every state, so a busy host overruns it. Claiming "all-users" on a
   * prefix is what turns a listener that did not fit into `listening: false`
   * — so a cut answer downgrades coverage to unknown and says why.
   */
  const coverageAfter = (
    p: ProbeResult,
    full: "all-users" | "self-only",
  ): "all-users" | "self-only" | null => {
    if (!p.truncated) return full;
    unknown.add(
      "socketCoverage",
      p.label,
      "the command printed more than this package reads and its output was cut short, so this socket list is only the beginning of the real one and an absent port is NOT evidence that it is free",
    );
    return null;
  };

  const ownersFromLsof = async (): Promise<LsofRecord[] | null> => {
    const fields = await probe(HOST_COMMANDS.lsofFields, timeoutMs, signal);
    if (fields.ok) {
      sources.push({ probe: fields.label, role: "owners", ok: true });
      return parseLsofFields(fields.stdout);
    }
    // lsof exits 1 both for an error and for "nothing matched", and on a
    // machine where this user owns no listening socket the second is the
    // normal case. Silence on both streams tells them apart: an empty answer
    // is an answer, and treating it as a failed probe would say the owners
    // are unknown when they are known to be none of this user's.
    if (fields.exitCode === 1 && fields.stdout.trim() === "" && fields.stderr.trim() === "") {
      sources.push({
        probe: fields.label,
        role: "owners",
        ok: true,
        note: "no listening socket belongs to this user",
      });
      return [];
    }
    // An lsof that rejects -F still answers in columns; the column form
    // truncates the command name to nine characters, which is why it is
    // second rather than first.
    const columns = await probe(HOST_COMMANDS.lsofColumns, timeoutMs, signal);
    if (columns.ok) {
      sources.push({
        probe: columns.label,
        role: "owners",
        ok: true,
        note: "column output: process names are truncated to 9 characters by lsof itself",
      });
      return parseLsofColumns(columns.stdout);
    }
    sources.push({ probe: fields.label, role: "owners", ok: false, reason: fields.reason });
    return null;
  };

  if (facts.platform === "darwin") {
    const netstat = await probe(HOST_COMMANDS.netstatBsd, timeoutMs, signal);
    const owners = await ownersFromLsof();
    const rows = netstat.ok ? dedupeSockets(parseBsdNetstat(netstat.stdout)) : null;
    // Rows, or the banner a netstat prints even on a host with no sockets.
    // Neither one means this was not netstat's output at all, and an empty
    // list from it would be read as "nothing is listening".
    if (rows !== null && (rows.length > 0 || looksLikeNetstatOutput(netstat.stdout))) {
      sources.unshift({
        probe: netstat.label,
        role: "sockets",
        ok: true,
        ...(netstat.truncated ? { note: "output was cut short at this package's cap" } : {}),
      });
      const sockets = rows;
      const joined = owners === null ? sockets : joinOwners(sockets, owners);
      if (joined.some((s) => !s.ownerKnown)) {
        // The normal case on macOS, and the one worth stating plainly: the
        // socket list is complete because netstat answered, but lsof could
        // only open its own uid's descriptors, so some of these sockets have
        // no name attached. They are listed anyway.
        unknown.add(
          "sockets[].owners",
          owners === null
            ? HOST_COMMANDS.lsofFields.join(" ")
            : `${HOST_COMMANDS.lsofFields.join(" ")} (as uid ${facts.uid ?? "unknown"})`,
          owners === null
            ? "no owner probe answered, so every socket here is reported without its process"
            : "an unprivileged lsof on macOS can open only its own uid's file descriptors, so sockets owned by other users are listed here with ownerKnown false rather than dropped",
        );
      }
      return {
        sockets: joined,
        coverage: coverageAfter(netstat, "all-users"),
        sources,
        ownerCoverage: owners === null ? "none" : isRoot ? "all" : "self-only",
      };
    }
    sources.unshift({
      probe: netstat.label,
      role: "sockets",
      ok: false,
      reason: netstat.ok ? UNPARSED : netstat.reason,
    });
    if (owners !== null) {
      // lsof alone. As an ordinary user it lists only this uid's processes,
      // so the socket list itself is partial — measured on macOS 26 while
      // building this package: netstat saw 20 listening sockets, lsof saw 8.
      unknown.add(
        "socketCoverage",
        HOST_COMMANDS.lsofFields.join(" "),
        "only lsof answered, and an unprivileged lsof on macOS can open only its own uid's descriptors, so sockets owned by other users are missing from this list",
      );
      const sockets = dedupeSockets(
        owners.map((record) => ({
          address: record.address,
          port: record.port,
          family: familyOf(record.address, record.address),
          owners: [
            { pid: record.pid, process: record.process, user: record.user, uid: record.uid },
          ],
          ownerKnown: record.process !== null,
        })),
      );
      return {
        sockets,
        coverage: isRoot ? "all-users" : "self-only",
        sources,
        ownerCoverage: isRoot ? "all" : "self-only",
      };
    }
    return { sockets: null, coverage: null, sources, ownerCoverage: "none" };
  }

  if (facts.platform === "win32") {
    const netstat = await probe(HOST_COMMANDS.netstatWindows, timeoutMs, signal);
    let sockets = netstat.ok ? dedupeSockets(parseWindowsNetstat(netstat.stdout)) : null;
    // `Proto` heads the table in every localisation, so it is the evidence
    // that this really was netstat talking rather than a wrapper's message.
    if (
      sockets === null ||
      (sockets.length === 0 && !looksLikeWindowsNetstatOutput(netstat.stdout))
    ) {
      sources.push({
        probe: netstat.label,
        role: "sockets",
        ok: false,
        reason: netstat.ok ? UNPARSED : netstat.reason,
      });
      return { sockets: null, coverage: null, sources, ownerCoverage: "none" };
    }
    sources.push({
      probe: netstat.label,
      role: "sockets",
      ok: true,
      ...(netstat.truncated ? { note: "output was cut short at this package's cap" } : {}),
    });
    const coverage = coverageAfter(netstat, "all-users");
    const tasklist = await probe(HOST_COMMANDS.tasklist, timeoutMs, signal);
    if (tasklist.ok) {
      sources.push({ probe: tasklist.label, role: "owners", ok: true });
      const names = parseTasklistCsv(tasklist.stdout);
      sockets = sockets.map((socket) => {
        const owners = socket.owners.map((owner) => ({
          ...owner,
          process: owner.pid === null ? null : (names.get(owner.pid) ?? null),
        }));
        return { ...socket, owners, ownerKnown: owners.some((o) => o.process !== null) };
      });
      const unnamed = sockets.some((s) => !s.ownerKnown);
      if (unnamed) {
        // tasklist answered, and a pid in the socket table is not in it: the
        // process exited between the two commands, or it is one tasklist
        // does not list for this user. Saying `ownerCoverage: "all"` there
        // would present a gap as a complete attribution.
        unknown.add(
          "sockets[].owners[].process",
          `${netstat.label}, ${tasklist.label}`,
          "a socket's owning pid was not in the process list — it exited between the two commands, or this user may not see it — so that socket keeps its pid and has no name",
        );
      }
      return { sockets, coverage, sources, ownerCoverage: unnamed ? "self-only" : "all" };
    }
    sources.push({ probe: tasklist.label, role: "owners", ok: false, reason: tasklist.reason });
    unknown.add(
      "sockets[].owners[].process",
      tasklist.label,
      `${tasklist.reason}; the owning pid is still reported`,
    );
    return { sockets, coverage, sources, ownerCoverage: "none" };
  }

  // Linux and anything else with /proc.
  const ss = await probe(HOST_COMMANDS.ss, timeoutMs, signal);
  const ssRows = ss.ok ? dedupeSockets(parseSsListen(ss.stdout)) : null;
  // `ss` prints its `State Recv-Q Send-Q …` header on a host with nothing
  // listening as much as on a busy one, so no rows AND no header means the
  // output was not ss's — which is a different fact from an idle machine.
  if (ssRows !== null && (ssRows.length > 0 || looksLikeSsOutput(ss.stdout))) {
    sources.push({
      probe: ss.label,
      role: "sockets+owners",
      ok: true,
      ...(ss.truncated ? { note: "output was cut short at this package's cap" } : {}),
    });
    const sockets = ssRows;
    const anyUnowned = sockets.some((s) => !s.ownerKnown);
    if (anyUnowned && !isRoot) {
      unknown.add(
        "sockets[].owners",
        ss.label,
        "ss lists every socket but prints the owning process only for processes this user may inspect; the sockets without one are reported with ownerKnown false, not omitted",
      );
    }
    return {
      sockets,
      coverage: coverageAfter(ss, "all-users"),
      sources,
      ownerCoverage: anyUnowned ? (isRoot ? "all" : "self-only") : "all",
    };
  }
  sources.push({
    probe: ss.label,
    role: "sockets+owners",
    ok: false,
    reason: ss.ok ? UNPARSED : ss.reason,
  });

  const netstat = await probe(HOST_COMMANDS.netstatLinux, timeoutMs, signal);
  const netstatRows = netstat.ok ? dedupeSockets(parseLinuxNetstat(netstat.stdout)) : null;
  if (netstatRows !== null && (netstatRows.length > 0 || looksLikeNetstatOutput(netstat.stdout))) {
    sources.push({
      probe: netstat.label,
      role: "sockets+owners",
      ok: true,
      ...(netstat.truncated ? { note: "output was cut short at this package's cap" } : {}),
    });
    const sockets = netstatRows;
    const anyUnowned = sockets.some((s) => !s.ownerKnown);
    if (anyUnowned && !isRoot) {
      unknown.add(
        "sockets[].owners",
        netstat.label,
        "netstat prints '-' instead of a pid for a process this user may not inspect; those sockets are reported with ownerKnown false",
      );
    }
    return {
      sockets,
      coverage: coverageAfter(netstat, "all-users"),
      sources,
      ownerCoverage: anyUnowned ? (isRoot ? "all" : "self-only") : "all",
    };
  }
  sources.push({
    probe: netstat.label,
    role: "sockets+owners",
    ok: false,
    reason: netstat.ok ? UNPARSED : netstat.reason,
  });

  // Neither tool is installed — common in a slim container. /proc is always
  // there, carries every socket, and names no process at all.
  // A file that exists but carries no `sl local_address` header is not the
  // proc table this parses (an empty file, a masked mount): it is read as
  // unreadable rather than as a family with no listeners.
  const readProc = (path: string): string | undefined => {
    const text = hostFs().readText(path);
    return text !== undefined && looksLikeProcNetTcp(text) ? text : undefined;
  };
  const v4 = readProc("/proc/net/tcp");
  const v6 = readProc("/proc/net/tcp6");
  if (v4 !== undefined || v6 !== undefined) {
    sources.push({
      probe: "/proc/net/tcp, /proc/net/tcp6",
      role: "sockets",
      ok: true,
      note: "both files are read: a dual-stack listener appears only in tcp6",
    });
    const sockets = dedupeSockets([
      ...(v4 === undefined ? [] : parseProcNetTcp(v4, "ipv4")),
      ...(v6 === undefined ? [] : parseProcNetTcp(v6, "ipv6")),
    ]);
    unknown.add(
      "sockets[].owners[].process",
      "/proc/net/tcp",
      "the proc files carry the owning uid but no pid or process name; naming the process would need a walk of /proc/*/fd",
    );
    if (v4 === undefined || v6 === undefined) {
      unknown.add(
        "socketCoverage",
        v4 === undefined ? "/proc/net/tcp" : "/proc/net/tcp6",
        "one of the two proc files could not be read, so sockets of that family are missing",
      );
      return { sockets, coverage: null, sources, ownerCoverage: "none" };
    }
    return { sockets, coverage: "all-users", sources, ownerCoverage: "none" };
  }
  sources.push({ probe: "/proc/net/tcp", role: "sockets", ok: false, reason: "not readable" });
  return { sockets: null, coverage: null, sources, ownerCoverage: "none" };
}

export const portInspect: RegisteredTool = buildTool({
  name: "PortInspect",
  operativeArgs: [],
  description:
    "List the TCP ports this machine is listening on, with the owning process where it can be read, and answer whether specific ports are in use. Use it before binding a port, or to find what is already holding one. A socket whose owner cannot be read is reported WITH an unknown owner rather than dropped, and `listening` is null — never false — when the probe that ran could not see every user's sockets.",
  inputSchema: z.object({
    ports: z
      .array(z.number().int().min(0).max(65535))
      .max(64)
      .optional()
      .describe(
        "ports to answer about specifically; matched against the parsed list, never passed to a command",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(`maximum sockets to return (default ${DEFAULT_SOCKET_LIMIT})`),
    timeoutMs: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const facts = hostFacts();
    const unknown = new Unknowns();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const reading = await readSockets(facts, timeoutMs, ctx?.signal, unknown);
    const limit = input.limit ?? DEFAULT_SOCKET_LIMIT;

    if (reading.sockets === null) {
      unknown.add(
        "sockets",
        reading.sources.map((s) => String(s["probe"])).join(", ") || "none",
        "no probe on this platform answered, so what is listening is unknown — this is NOT a machine with nothing listening",
      );
    }

    if (reading.coverage === null && !unknown.has("socketCoverage")) {
      unknown.add(
        "socketCoverage",
        reading.sources.map((s) => String(s["probe"])).join(", ") || "none",
        "it could not be established whether the probe that answered sees every user's sockets, so an absent port is not evidence that it is free",
      );
    }

    const all = reading.sockets === null ? null : sortSockets(reading.sockets);
    const shown = all === null ? null : all.slice(0, limit);
    const truncated =
      all !== null && shown !== null && all.length > shown.length
        ? { returned: shown.length, total: all.length }
        : undefined;

    const queried =
      input.ports === undefined
        ? undefined
        : [...new Set(input.ports)]
            .sort((a, b) => a - b)
            .map((port) => {
              const listeners =
                all === null ? [] : all.filter((s) => s.port === port).map(renderSocket);
              if (listeners.length > 0) {
                return { port, listening: true, listeners };
              }
              // Absence is only evidence when the source saw every user's
              // sockets. Otherwise the honest answer is that it is unknown,
              // and the caller can decide to try the bind anyway.
              if (reading.coverage === "all-users")
                return { port, listening: false, listeners: [] };
              unknown.add(
                "queried[].listening",
                reading.sources.map((s) => String(s["probe"])).join(", ") || "none",
                "the probe that answered does not see every user's sockets, so an absent port cannot be reported as free",
              );
              return { port, listening: null, listeners: [] };
            });

    return json(
      compact({
        protocol: "tcp",
        sources: reading.sources,
        socketCoverage: reading.coverage,
        ownerCoverage: reading.ownerCoverage,
        sockets: shown === null ? null : shown.map(renderSocket),
        truncated,
        queried,
        unknown: unknown.list(),
      }),
    );
  },
});

export const HOST_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  networkInfo,
  portInspect,
  systemInfo,
]);

export type { UnknownFact as HostUnknownFact };
