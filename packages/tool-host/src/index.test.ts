/**
 * The three tools, driven the way the runtime drives them — with the host
 * replaced.
 *
 * Every test here states the machine it is about: the platform, the runtime's
 * readings, which commands exist and what they print, and what is readable
 * under /proc. Nothing reaches the real host, so a test that says "this is a
 * Windows laptop with a battery at 87%" means it on CI's Linux box as much as
 * on a developer's Mac. The one test in this package that touches the real
 * machine lives in integration.test.ts and asserts only shape.
 *
 * Two invariants are tested generically at the bottom, because they are the
 * package's whole contract: every null is explained, and no argv is ever
 * built from input.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type HostFacts, type HostFs, _setFs, _setHostFacts } from "./facts";
import * as F from "./fixtures";
import { HOST_TOOLS, networkInfo, portInspect, systemInfo } from "./index";
import { HOST_COMMANDS, type HostRunOutcome, _setRunner } from "./run";

afterEach(() => {
  _setRunner(undefined);
  _setFs(undefined);
  _setHostFacts(undefined);
});

// ---------------------------------------------------------------------------
// the machines these tests are about
// ---------------------------------------------------------------------------

/** A complete, synthetic set of runtime readings. Nothing is inherited from
 *  the machine running the test — see `_setHostFacts`. */
function facts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    platform: "linux",
    arch: "x64",
    release: "6.8.0-40-generic",
    type: "Linux",
    version: "#40-Ubuntu SMP",
    hostname: "runner",
    uptimeSeconds: 86_400,
    totalMemBytes: 16 * 1024 ** 3,
    freeMemBytes: 2 * 1024 ** 3,
    cpus: [
      { model: "Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz", speed: 1900 },
      { model: "Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz", speed: 1900 },
      { model: "Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz", speed: 1900 },
      { model: "Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz", speed: 1900 },
    ],
    loadAverage: [0.4, 0.5, 0.6],
    uid: 1000,
    env: {},
    dnsServers: ["127.0.0.53"],
    interfaces: {},
    runtime: { name: "bun", version: "1.3.11" },
    ...overrides,
  };
}

const macFacts = (overrides: Partial<HostFacts> = {}): HostFacts =>
  facts({
    platform: "darwin",
    arch: "arm64",
    release: "25.6.0",
    type: "Darwin",
    hostname: "studio",
    cpus: [
      { model: "Apple M1", speed: 24 },
      { model: "Apple M1", speed: 24 },
    ],
    uid: 501,
    dnsServers: ["1.1.1.1"],
    ...overrides,
  });

const windowsFacts = (overrides: Partial<HostFacts> = {}): HostFacts =>
  facts({
    platform: "win32",
    type: "Windows_NT",
    release: "10.0.26100",
    hostname: "DESKTOP-1",
    // Documented Windows behaviour: not a measurement.
    loadAverage: [0, 0, 0],
    // On Windows os.freemem() is AVAILABLE physical memory.
    freeMemBytes: 6 * 1024 ** 3,
    uid: undefined,
    dnsServers: ["192.168.1.1"],
    ...overrides,
  });

/** A filesystem that knows only what the test hands it. Anything else is
 *  unreadable, which is what a macOS host looks like to `/proc`. */
function fsWith(
  files: Record<string, string>,
  dirs: Record<string, string[]> = {},
  statfs: HostFs["statfs"] = () => undefined,
): HostFs {
  return {
    readText: (path) => files[path],
    listDir: (path) => dirs[path],
    statfs,
  };
}

const EMPTY_FS = fsWith({});

type CommandTable = Record<
  string,
  | string
  | {
      stdout?: string;
      failure?: HostRunOutcome["failure"];
      stderr?: string;
      /** The runner hit its output cap: what follows is a PREFIX. */
      truncated?: boolean;
    }
>;

/** Install a runner that answers from a table keyed by the joined argv, and
 *  record every call. A command missing from the table is "not installed",
 *  which is the most common real failure. */
function useRunner(table: CommandTable): { calls: string[][] } {
  const calls: string[][] = [];
  _setRunner(async (argv) => {
    calls.push([...argv]);
    const entry = table[argv.join(" ")];
    if (entry === undefined) {
      return {
        argv,
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "spawn ENOENT",
        failure: "not-installed",
      };
    }
    if (typeof entry === "string") {
      return { argv, ok: true, exitCode: 0, stdout: entry, stderr: "" };
    }
    return {
      argv,
      ok: entry.failure === undefined,
      exitCode: entry.failure === undefined ? 0 : 1,
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
      ...(entry.truncated === true ? { stdoutTruncated: true } : {}),
      ...(entry.failure === undefined ? {} : { failure: entry.failure }),
    };
  });
  return { calls };
}

const cmd = (argv: ReadonlyArray<string>): string => argv.join(" ");

/**
 * The shape each tool promises, written out rather than reached for with
 * `any` — these types ARE the contract under test, and an optional key here
 * means "absent when not applicable" exactly as the results do.
 */
type UnknownEntry = { field: string; probe: string; reason: string };
type WithUnknown = { unknown: UnknownEntry[] };

type SystemResult = WithUnknown & {
  os: {
    platform: string;
    arch: string;
    hostname: string | null;
    kernel: Record<string, string>;
    distro: Record<string, string> | null;
  };
  cpu: {
    model: string | null;
    logicalCores: number | null;
    physicalCores: number | null;
    loadAverage: number[] | null;
  };
  memory: { totalBytes: number | null; freeBytes: number | null; availableBytes: number | null };
  uptimeSeconds: number | null;
  runtime: { name: string; version: string };
  battery: {
    present: boolean | null;
    percent?: number | null;
    charging?: boolean | null;
    powerSource?: string | null;
  };
  disk: {
    path: string;
    totalBytes: number | null;
    freeBytes: number | null;
    availableBytes: number | null;
  };
};

type AddressJson = {
  family: string;
  address: string;
  prefixLength?: number;
  scope?: string;
  zone?: string;
};
type InterfaceJson = {
  name: string;
  adminUp?: boolean | null;
  link?: string | null;
  loopback?: boolean | null;
  mtu?: number | null;
  mac?: string | null;
  addresses: AddressJson[];
};
type ProxyEntryJson = { url: string; from: string; credentials: string };
type NetworkResult = WithUnknown & {
  interfaces: InterfaceJson[] | null;
  interfaceSource?: string;
  dns: { resolvers: string[] | null; searchDomains: string[] | null; source: string };
  proxy: {
    http?: ProxyEntryJson;
    https?: ProxyEntryJson;
    all?: ProxyEntryJson;
    noProxy?: string[];
    configured?: boolean;
    conflicts?: string[];
  };
};

type OwnerJson = { pid?: number; process?: string; user?: string; uid?: number };
type SocketJson = {
  address: string;
  port: number;
  family: string;
  owners: OwnerJson[];
  ownerKnown: boolean;
};
type PortsResult = WithUnknown & {
  protocol: string;
  sources: Array<{ probe: string; role: string; ok: boolean; reason?: string; note?: string }>;
  socketCoverage: string | null;
  ownerCoverage: string;
  sockets: SocketJson[] | null;
  truncated?: { returned: number; total: number };
  queried?: Array<{ port: number; listening: boolean | null; listeners: SocketJson[] }>;
};

async function call<T extends WithUnknown>(tool: RegisteredTool, input: unknown): Promise<T> {
  return JSON.parse((await tool.execute(input)) as string) as T;
}

/** The entry recorded for a field. Throwing here — with the fields that WERE
 *  recorded — beats an "undefined is not an object" ten frames away. */
function unknownFor(result: WithUnknown, field: string): UnknownEntry {
  const entry = result.unknown.find((u) => u.field === field);
  if (entry === undefined) {
    const recorded = result.unknown.map((u) => u.field).join(", ");
    throw new Error(`no unknown entry for "${field}"; recorded: ${recorded || "(none)"}`);
  }
  return entry;
}

const fieldsOf = (result: WithUnknown): string[] => result.unknown.map((u) => u.field);

/** The sockets, insisting a list was produced at all — `null` there is a
 *  different outcome, and the tests about it say so explicitly. */
function socketsOf(result: PortsResult): SocketJson[] {
  if (result.sockets === null) throw new Error("expected a socket list, got null");
  return result.sockets;
}

function interfacesOf(result: NetworkResult): InterfaceJson[] {
  if (result.interfaces === null) throw new Error("expected an interface list, got null");
  return result.interfaces;
}

const MACOS_COMMANDS: CommandTable = {
  [cmd(HOST_COMMANDS.uname)]: F.MACOS_UNAME,
  [cmd(HOST_COMMANDS.swVers)]: F.MACOS_SW_VERS,
  [cmd(HOST_COMMANDS.sysctl)]: F.MACOS_SYSCTL,
  [cmd(HOST_COMMANDS.pmset)]: F.MACOS_PMSET_DISCHARGING,
  [cmd(HOST_COMMANDS.ifconfig)]: F.MACOS_IFCONFIG,
  [cmd(HOST_COMMANDS.netstatBsd)]: F.MACOS_NETSTAT_TCP,
  [cmd(HOST_COMMANDS.lsofFields)]: F.MACOS_LSOF_FIELDS,
};

const LINUX_COMMANDS: CommandTable = {
  [cmd(HOST_COMMANDS.uname)]:
    "Linux 6.8.0-40-generic #40-Ubuntu SMP Fri Jul 5 10:34:03 UTC 2026 x86_64\n",
  [cmd(HOST_COMMANDS.ipJson)]: F.LINUX_IP_J_ADDR,
  [cmd(HOST_COMMANDS.ss)]: F.LINUX_SS_LTNP,
};

const LINUX_FILES = {
  "/proc/cpuinfo": F.LINUX_PROC_CPUINFO_X86,
  "/proc/meminfo": F.LINUX_PROC_MEMINFO,
  "/etc/os-release": F.LINUX_OS_RELEASE_DEBIAN,
  "/etc/resolv.conf": F.LINUX_RESOLV_CONF_SEARCH,
};

// ---------------------------------------------------------------------------
// SystemInfo
// ---------------------------------------------------------------------------

describe("SystemInfo", () => {
  test("macOS: the kernel, the product version and the cpu counts", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<SystemResult>(systemInfo, {});
    expect(result["os"]["distro"]).toEqual({ name: "macOS", version: "26.6.2", build: "25G83" });
    expect(result["os"]["kernel"]).toMatchObject({
      name: "Darwin",
      release: "25.6.0",
      machine: "arm64",
    });
    // sysctl answers the physical count; the runtime answers the logical one.
    expect(result["cpu"]).toMatchObject({ physicalCores: 8, logicalCores: 2, model: "Apple M1" });
    expect(result["unknown"]).toEqual([
      expect.objectContaining({ field: "memory.availableBytes" }),
    ]);
  });

  test("macOS: available memory is unknown rather than guessed from free pages", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { sections: ["memory"] });
    expect(result["memory"]["availableBytes"]).toBeNull();
    expect(result["memory"]["totalBytes"]).toBe(16 * 1024 ** 3);
    expect(result["unknown"][0]["reason"]).toContain("no available-memory figure");
  });

  test("Linux: MemAvailable is reported, and it is not MemFree", async () => {
    _setHostFacts(facts());
    _setFs(fsWith(LINUX_FILES));
    useRunner(LINUX_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { sections: ["memory", "os"] });
    expect(result["memory"]["availableBytes"]).toBe(12351268 * 1024);
    expect(result["memory"]["freeBytes"]).toBe(11001140 * 1024);
    expect(result["os"]["distro"]).toMatchObject({ name: "Debian GNU/Linux", version: "13" });
  });

  test("Linux on ARM: physical cores are unknown and say why", async () => {
    _setHostFacts(facts({ arch: "arm64", cpus: [] }));
    _setFs(fsWith({ ...LINUX_FILES, "/proc/cpuinfo": F.LINUX_PROC_CPUINFO_ARM64 }));
    useRunner(LINUX_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { sections: ["cpu"] });
    expect(result["cpu"]["logicalCores"]).toBe(4);
    expect(result["cpu"]["physicalCores"]).toBeNull();
    const reason = unknownFor(result, "cpu.physicalCores")["reason"];
    expect(reason).toContain("physical id");
    expect(reason).toContain("SMT");
  });

  test("a container where os.cpus() is empty falls through to /proc, not to zero", async () => {
    // The headline defect: an empty cpu list is not a machine with no CPUs.
    _setHostFacts(facts({ cpus: [] }));
    _setFs(fsWith(LINUX_FILES));
    useRunner(LINUX_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { sections: ["cpu"] });
    expect(result["cpu"]["logicalCores"]).toBe(4);
    expect(result["cpu"]["physicalCores"]).toBe(2);
    // And nothing claims the count is unknown next to the count.
    expect(fieldsOf(result)).toEqual([]);
  });

  test("when no probe can count the cores, the answer is null and never 0", async () => {
    _setHostFacts(facts({ cpus: [] }));
    _setFs(EMPTY_FS); // no /proc at all
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["cpu"] });
    expect(result["cpu"]["logicalCores"]).toBeNull();
    expect(result["cpu"]["logicalCores"]).not.toBe(0);
    expect(result["cpu"]["model"]).toBeNull();
    const fields = fieldsOf(result);
    expect(fields).toContain("cpu.logicalCores");
    expect(fields).toContain("cpu.model");
  });

  test("Windows: the load average is null, not the [0,0,0] the runtime returns", async () => {
    _setHostFacts(windowsFacts());
    _setFs(EMPTY_FS);
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["cpu", "memory", "os"] });
    expect(result["cpu"]["loadAverage"]).toBeNull();
    const reason = unknownFor(result, "cpu.loadAverage")["reason"];
    expect(reason).toContain("[0,0,0]");
    // freemem() means available on Windows, so it is reported as available.
    expect(result["memory"]["availableBytes"]).toBe(6 * 1024 ** 3);
    expect(result["memory"]["freeBytes"]).toBeNull();
    expect(result["os"]["distro"]).toBeNull();
  });

  test("Windows: uname is not even attempted", async () => {
    _setHostFacts(windowsFacts());
    _setFs(EMPTY_FS);
    const { calls } = useRunner({});
    await call<SystemResult>(systemInfo, { sections: ["os"] });
    expect(calls).toEqual([]);
  });

  test("a desktop Mac reports no battery, never 0%", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner({ ...MACOS_COMMANDS, [cmd(HOST_COMMANDS.pmset)]: F.MACOS_PMSET_NO_BATTERY });
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(result["battery"]).toEqual({ present: false, powerSource: "ac" });
    // Not applicable rather than unknown: the key is absent, not null.
    expect("percent" in result["battery"]).toBe(false);
    expect(result["unknown"]).toEqual([]);
  });

  test("a laptop reports the charge and the direction", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(result["battery"]).toEqual({
      present: true,
      percent: 63,
      charging: false,
      powerSource: "battery",
    });
  });

  test("Linux reads the battery from sysfs, with no command at all", async () => {
    _setHostFacts(facts());
    _setFs(
      fsWith(
        {
          "/sys/class/power_supply/BAT0/capacity": F.LINUX_SYSFS_BATTERY_CAPACITY,
          "/sys/class/power_supply/BAT0/status": F.LINUX_SYSFS_BATTERY_STATUS_DISCHARGING,
        },
        { "/sys/class/power_supply": ["AC", "BAT0"] },
      ),
    );
    const { calls } = useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(result["battery"]).toMatchObject({ present: true, percent: 87, charging: false });
    // upower would need a device path from `upower -e` in its argv; sysfs
    // needs no command, which is why it is preferred.
    expect(calls).toEqual([]);
  });

  test("an empty power_supply directory is no battery; a missing one is unknown", async () => {
    _setHostFacts(facts());
    _setFs(fsWith({}, { "/sys/class/power_supply": [] }));
    useRunner({});
    expect((await call<SystemResult>(systemInfo, { sections: ["battery"] }))["battery"]).toEqual({
      present: false,
    });

    _setFs(EMPTY_FS);
    const unreadable = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(unreadable["battery"]).toEqual({ present: null });
    expect(unreadable["unknown"][0]["reason"]).toContain("could not be distinguished");
  });

  test("a battery probe that is not installed is unknown, with that reason", async () => {
    _setHostFacts(windowsFacts());
    _setFs(EMPTY_FS);
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(result["battery"]).toEqual({ present: null });
    const entry = unknownFor(result, "battery.present");
    // Rule: a failure assertion a timeout could also satisfy must say WHICH.
    expect(entry["reason"]).toContain("not installed");
    expect(entry["reason"]).toContain("24H2");
    expect(entry["probe"]).toContain("wmic");
  });

  test("a probe that times out says so, rather than looking like a refusal", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner({
      ...MACOS_COMMANDS,
      [cmd(HOST_COMMANDS.pmset)]: { failure: "timed-out", stderr: "" },
    });
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    const entry = unknownFor(result, "battery.present");
    expect(entry["reason"]).toContain("timeout");
    expect(entry["reason"]).not.toContain("not installed");
  });

  test("disk reports available separately from free", async () => {
    _setHostFacts(facts());
    _setFs({
      readText: () => undefined,
      listDir: () => undefined,
      statfs: () => ({ bsize: 4096, blocks: 1_000_000, bfree: 100_000, bavail: 48_000 }),
    });
    useRunner(LINUX_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { diskPath: ".", sections: [] });
    expect(result["disk"]).toEqual({
      path: ".",
      totalBytes: 4096 * 1_000_000,
      freeBytes: 4096 * 100_000,
      availableBytes: 4096 * 48_000,
    });
  });

  test("a disk path outside the workspace is refused, not measured", async () => {
    _setHostFacts(facts());
    _setFs({
      readText: () => undefined,
      listDir: () => undefined,
      statfs: () => ({ bsize: 4096, blocks: 1, bfree: 1, bavail: 1 }),
    });
    useRunner({});
    const refusal = await systemInfo.execute({ diskPath: "../../../etc", sections: [] });
    expect(refusal).toContain("refused path");
    expect(refusal).toContain("outside the workspace root");
  });

  test("the disk section without a path is a refusal that says what is missing", async () => {
    _setHostFacts(facts());
    _setFs(EMPTY_FS);
    useRunner({});
    const refusal = await systemInfo.execute({ sections: ["disk"] });
    expect(refusal).toContain("needs diskPath");
  });

  test("a failed statfs is null bytes, not a full disk", async () => {
    _setHostFacts(facts());
    _setFs(EMPTY_FS); // statfs returns undefined
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { diskPath: ".", sections: [] });
    expect(result["disk"]["availableBytes"]).toBeNull();
    expect(fieldsOf(result)).toContain("disk.availableBytes");
  });

  test("a statfs reading this tool refuses is explained, not a bare null", async () => {
    // statfs ANSWERED here — it is the numbers that are unusable. `bavail`
    // really does go negative when the root-reserved pool is overdrawn, and
    // statfsSync returns negative counts on APFS, so the byte figure is
    // refused. Refusing it silently is the half that was missing: the field
    // a caller is told to gate on came back null with an empty `unknown`,
    // which reads as "measured, and it is nothing".
    _setHostFacts(facts());
    _setFs(fsWith({}, {}, () => ({ bsize: 4096, blocks: 1_000_000, bfree: 1_000, bavail: -12 })));
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { diskPath: ".", sections: [] });
    expect(result["disk"]["totalBytes"]).toBe(4096 * 1_000_000);
    expect(result["disk"]["availableBytes"]).toBeNull();
    expect(unknownFor(result, "disk.availableBytes").reason).toContain("statfs answered");
    // …and the fields that DID read are not claimed to be unknown.
    expect(fieldsOf(result)).not.toContain("disk.totalBytes");
  });

  test("a battery device that cannot be read is unknown, and names the device", async () => {
    // The directory lists a battery and neither of its files can be read (a
    // permission, a driver that went away). Before, this answered
    // `present: null` with an empty `unknown` — the one shape this package
    // promises never to emit.
    _setHostFacts(facts());
    _setFs(fsWith({}, { "/sys/class/power_supply": ["AC", "BAT0"] }));
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(result["battery"]).toEqual({ present: null });
    expect(unknownFor(result, "battery.present").probe).toBe("/sys/class/power_supply/BAT0");
  });

  test("a wireless mouse's cell is not this machine's battery", async () => {
    // A DESKTOP with a Logitech mouse. `hidpp_battery_0` is type Battery
    // with scope Device — the kernel's own way of saying it powers a
    // peripheral. Matched by name, this desktop reported itself as running
    // on battery at 12%, and a workflow gating on charge acts on that.
    _setHostFacts(facts());
    _setFs(
      fsWith(
        {
          "/sys/class/power_supply/AC/type": "Mains\n",
          "/sys/class/power_supply/hidpp_battery_0/type": "Battery\n",
          "/sys/class/power_supply/hidpp_battery_0/scope": "Device\n",
          "/sys/class/power_supply/hidpp_battery_0/capacity": "12\n",
          "/sys/class/power_supply/hidpp_battery_0/status": "Discharging\n",
        },
        { "/sys/class/power_supply": ["AC", "hidpp_battery_0"] },
      ),
    );
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    // No system battery, which IS a measurement: the directory listed.
    expect(result["battery"]).toEqual({ present: false });
    expect(JSON.stringify(result)).not.toContain("12");
  });

  test("macOS: a battery a charge limiter holds is not reported as charging", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner({ ...MACOS_COMMANDS, [cmd(HOST_COMMANDS.pmset)]: F.MACOS_PMSET_NOT_CHARGING });
    const result = await call<SystemResult>(systemInfo, { sections: ["battery"] });
    expect(result["battery"]).toMatchObject({ present: true, percent: 80, powerSource: "ac" });
    expect(result["battery"]["charging"]).toBeNull();
    expect(unknownFor(result, "battery.charging").reason).toContain("Not charging");
  });

  test("an os-release that named nothing is null, not a distro with no name", async () => {
    // The file was there and readable, and nothing in it is a key this
    // reads (a truncated write, a stub image). `{}` says "a distro, and we
    // know nothing about it"; null plus a reason says what happened.
    _setHostFacts(facts());
    _setFs(fsWith({ "/etc/os-release": "# nothing but a comment\n" }));
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["os"] });
    expect(result["os"]["distro"]).toBeNull();
    expect(unknownFor(result, "os.distro").reason).toContain("nothing in its output named");
  });

  test("Windows: an available-memory reading of zero is unknown, not zero", async () => {
    // freemem() on Windows is AVAILABLE memory, and the code moves it into
    // that field. A 0 from the runtime is not a measurement of anything, so
    // the field goes null — and a null has to carry its reason with it.
    _setHostFacts(windowsFacts({ freeMemBytes: 0 }));
    _setFs(EMPTY_FS);
    useRunner({});
    const result = await call<SystemResult>(systemInfo, { sections: ["memory"] });
    expect(result["memory"]["availableBytes"]).toBeNull();
    expect(fieldsOf(result)).toContain("memory.availableBytes");
  });

  test("a sysctl that exits 1 over one unknown key still answers for the rest", async () => {
    // sysctl exits 1 if ANY key it is given is unknown to the kernel, while
    // still printing the ones it knows. Throwing the whole answer away over
    // one missing key would lose the core count it did report.
    _setHostFacts(macFacts({ cpus: [] }));
    _setFs(EMPTY_FS);
    useRunner({
      ...MACOS_COMMANDS,
      [cmd(HOST_COMMANDS.sysctl)]: {
        failure: "exit-nonzero",
        stdout: F.MACOS_SYSCTL,
        stderr: "sysctl: unknown oid 'hw.bogus'",
      },
    });
    const result = await call<SystemResult>(systemInfo, { sections: ["cpu"] });
    expect(result["cpu"]).toMatchObject({ logicalCores: 8, physicalCores: 8, model: "Apple M1" });
    expect(fieldsOf(result)).not.toContain("cpu.physicalCores");
  });

  test("a probe that failed does not make a fact the runtime knows unknown", async () => {
    // /proc/cpuinfo is unreadable here, but os.cpus() named the model. An
    // unknown entry for cpu.model would be a claim that contradicts the
    // result sitting next to it.
    _setHostFacts(facts());
    _setFs(EMPTY_FS);
    useRunner(LINUX_COMMANDS);
    const result = await call<SystemResult>(systemInfo, { sections: ["cpu"] });
    expect(result["cpu"]["model"]).toContain("i7-8650U");
    expect(fieldsOf(result)).not.toContain("cpu.model");
    expect(fieldsOf(result)).toContain("cpu.physicalCores");
  });

  test("two identical calls return identical bytes", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const first = await systemInfo.execute({});
    const second = await systemInfo.execute({});
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// NetworkInfo
// ---------------------------------------------------------------------------

describe("NetworkInfo", () => {
  test("JSON is preferred where it exists, and the text form is not run", async () => {
    _setHostFacts(facts());
    _setFs(fsWith(LINUX_FILES));
    const { calls } = useRunner(LINUX_COMMANDS);
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    expect(result["interfaceSource"]).toBe("ip -j addr");
    expect(calls.map((c) => c.join(" "))).toEqual(["ip -j addr"]);
    expect(result["interfaces"][1]).toMatchObject({ name: "enp0s31f6", mtu: 1500, link: "active" });
  });

  test("busybox rejects -j, so the text form answers", async () => {
    // Captured: exit 1 and a usage message. The fallback is the whole reason
    // the text parser exists.
    _setHostFacts(facts());
    _setFs(fsWith(LINUX_FILES));
    const { calls } = useRunner({
      [cmd(HOST_COMMANDS.ipJson)]: { failure: "exit-nonzero", stderr: F.LINUX_IP_J_UNSUPPORTED },
      [cmd(HOST_COMMANDS.ipText)]: F.LINUX_IP_ADDR_TEXT,
    });
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    expect(calls.map((c) => c.join(" "))).toEqual(["ip -j addr", "ip addr"]);
    expect(result["interfaceSource"]).toBe("ip addr");
    expect(interfacesOf(result).map((i) => i.name)).toEqual(["lo", "tunl0", "ip6tnl0", "eth0"]);
  });

  test("macOS parses ifconfig, hex netmask and all", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    const en1 = interfacesOf(result).find((i) => i.name === "en1");
    expect(en1["addresses"][0]).toEqual({
      family: "ipv4",
      address: "192.168.7.42",
      prefixLength: 24,
    });
    expect(en1["link"]).toBe("active");
  });

  test("with no command at all, the runtime's table answers and says what it lacks", async () => {
    _setHostFacts(
      windowsFacts({
        interfaces: {
          Ethernet: [
            {
              address: "192.168.1.10",
              family: "IPv4",
              internal: false,
              mac: "aa:bb:cc:dd:ee:ff",
              netmask: "255.255.255.0",
              cidr: "192.168.1.10/24",
            },
          ],
        },
      }),
    );
    _setFs(EMPTY_FS);
    useRunner({});
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    expect(result["interfaceSource"]).toBe("node:os networkInterfaces()");
    expect(result["interfaces"][0]).toMatchObject({ name: "Ethernet", mtu: null, adminUp: null });
    const fields = fieldsOf(result);
    expect(fields).toContain("interfaces[].mtu");
    expect(unknownFor(result, "interfaces[].mtu")["reason"]).toContain(
      "omits interfaces that are down",
    );
  });

  test("when nothing answers, interfaces is null — NOT an empty list", async () => {
    // An empty array reads as "this machine has no network", which is a
    // different fact and one a caller acts on.
    _setHostFacts(facts({ interfaces: {} }));
    _setFs(EMPTY_FS);
    useRunner({});
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    expect(result["interfaces"]).toBeNull();
    const entry = unknownFor(result, "interfaces");
    expect(entry["reason"]).toContain("NOT a machine with no network");
    // Every probe that was tried is named, so the caller can install one.
    expect(entry["probe"]).toContain("ip -j addr");
    expect(entry["probe"]).toContain("ifconfig -a");
  });

  test("an ifconfig this parser cannot read is unknown, not a machine with no network", async () => {
    // A host with no `ip` at all, whose `ifconfig` is busybox's — captured
    // from a real container, exit code 0, 1.4 KB of interfaces the BSD
    // parser cannot see. The command SUCCEEDED, so the old code returned
    // what the parser found: `interfaces: []` with an empty `unknown` and
    // `interfaceSource: "ifconfig -a"`, which reads as a machine with no
    // network on the strength of a probe that ran fine.
    _setHostFacts(facts({ interfaces: {} }));
    _setFs(EMPTY_FS);
    useRunner({ [cmd(HOST_COMMANDS.ifconfig)]: F.LINUX_IFCONFIG_BUSYBOX });
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    expect(result["interfaces"]).toBeNull();
    expect(result["interfaceSource"]).toBeUndefined();
    const entry = unknownFor(result, "interfaces");
    expect(entry["probe"]).toContain("ifconfig -a (the command ran but no interface");
    expect(entry["reason"]).toContain("NOT a machine with no network");
  });

  test("an `ip addr` that printed something else falls through to the next probe", async () => {
    // The same rule one rung up the ladder: `ip addr` exited 0 with output
    // the text parser finds nothing in, so the answer is not "no
    // interfaces" — ifconfig is asked next, and here it answers.
    _setHostFacts(macFacts({ platform: "linux", interfaces: {} }));
    _setFs(EMPTY_FS);
    const { calls } = useRunner({
      [cmd(HOST_COMMANDS.ipText)]: 'Object "addr" is unknown, try "ip help".\n',
      [cmd(HOST_COMMANDS.ifconfig)]: F.MACOS_IFCONFIG,
    });
    const result = await call<NetworkResult>(networkInfo, { sections: ["interfaces"] });
    expect(result["interfaceSource"]).toBe("ifconfig -a");
    expect(interfacesOf(result).length).toBeGreaterThan(0);
    expect(calls.map((c) => c.join(" "))).toEqual(["ip -j addr", "ip addr", "ifconfig -a"]);
  });

  test("the interface filter runs on the parsed list, so a flag matches nothing", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    const { calls } = useRunner(MACOS_COMMANDS);
    const result = await call<NetworkResult>(networkInfo, {
      sections: ["interfaces"],
      interfaceName: "-a",
    });
    expect(result["interfaces"]).toEqual([]);
    expect(calls).toEqual([[...HOST_COMMANDS.ifconfig]]);

    const named = await call<NetworkResult>(networkInfo, {
      sections: ["interfaces"],
      interfaceName: "en1",
    });
    expect(interfacesOf(named).map((i) => i.name)).toEqual(["en1"]);
  });

  test("resolv.conf decides what an empty resolver list means", async () => {
    _setHostFacts(facts({ dnsServers: [] }));
    _setFs(fsWith(LINUX_FILES));
    useRunner(LINUX_COMMANDS);
    const result = await call<NetworkResult>(networkInfo, { sections: ["dns"] });
    expect(result["dns"]).toMatchObject({
      resolvers: ["127.0.0.53", "10.0.0.1"],
      searchDomains: ["example.com", "internal.example.com"],
      source: "/etc/resolv.conf",
    });
  });

  test("no resolvers and no readable config is unknown, not 'none configured'", async () => {
    _setHostFacts(facts({ dnsServers: [] }));
    _setFs(EMPTY_FS);
    useRunner(LINUX_COMMANDS);
    const result = await call<NetworkResult>(networkInfo, { sections: ["dns"] });
    expect(result["dns"]["resolvers"]).toBeNull();
    expect(unknownFor(result, "dns.resolvers")["reason"]).toContain("unreadable");
  });

  test("proxy credentials never reach the result", async () => {
    _setHostFacts(
      facts({
        env: {
          http_proxy: "http://alice:hunter2@proxy.example.com:3128",
          HTTP_PROXY: "http://attacker.example:80",
          no_proxy: "localhost,.internal",
        },
      }),
    );
    _setFs(EMPTY_FS);
    useRunner(LINUX_COMMANDS);
    const raw = await networkInfo.execute({ sections: ["proxy"] });
    expect(raw).not.toContain("hunter2");
    const result = JSON.parse(raw);
    expect(result["proxy"]["http"]).toEqual({
      url: "http://proxy.example.com:3128",
      from: "http_proxy",
      credentials: "redacted",
    });
    expect(result["proxy"]["conflicts"][0]).toContain("httpoxy");
  });

  test("an unset proxy is an absent key, not a null", async () => {
    _setHostFacts(facts({ env: {} }));
    _setFs(EMPTY_FS);
    useRunner(LINUX_COMMANDS);
    const result = await call<NetworkResult>(networkInfo, { sections: ["proxy"] });
    expect(result["proxy"]).toEqual({ configured: false });
  });
});

// ---------------------------------------------------------------------------
// PortInspect
// ---------------------------------------------------------------------------

describe("PortInspect", () => {
  test("macOS: sockets come from netstat, owners from lsof, and neither is dropped", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<PortsResult>(portInspect, {});
    expect(result["socketCoverage"]).toBe("all-users");
    expect(result["ownerCoverage"]).toBe("self-only");

    // Root's cupsd: netstat sees the socket, an unprivileged lsof does not.
    const cups = socketsOf(result).find((s) => s.port === 631 && s.address === "127.0.0.1");
    expect(cups).toMatchObject({ ownerKnown: false, owners: [] });
    // …and one this user owns keeps its name.
    const ollama = socketsOf(result).find((s) => s.port === 11434);
    expect(ollama["owners"][0]).toEqual({ pid: 805, process: "ollama", user: "agent", uid: 501 });

    const entry = unknownFor(result, "sockets[].owners");
    expect(entry["reason"]).toContain("rather than dropped");
  });

  test("a port nothing holds is reported free only when every user's sockets were seen", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<PortsResult>(portInspect, { ports: [631, 9999] });
    expect(result["queried"]).toEqual([
      expect.objectContaining({ port: 631, listening: true }),
      { port: 9999, listening: false, listeners: [] },
    ]);
  });

  test("when only lsof answers, an absent port is null — never false", async () => {
    // This is the failure the tool exists to avoid: as an ordinary user lsof
    // shows 8 of this machine's 20 listening sockets, so "not in the list"
    // is not evidence of anything.
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner({ [cmd(HOST_COMMANDS.lsofFields)]: F.MACOS_LSOF_FIELDS });
    const result = await call<PortsResult>(portInspect, { ports: [631, 11434] });
    expect(result["socketCoverage"]).toBe("self-only");
    expect(result["queried"][0]).toEqual({ port: 631, listening: null, listeners: [] });
    expect(result["queried"][1]).toMatchObject({ port: 11434, listening: true });
    const entry = unknownFor(result, "queried[].listening");
    expect(entry["reason"]).toContain("cannot be reported as free");
  });

  test("an lsof that matched nothing is an empty owner list, not a failed probe", async () => {
    // lsof exits 1 both for an error and for "nothing matched", and on a
    // machine where this user owns no listening socket the second is normal.
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner({
      ...MACOS_COMMANDS,
      [cmd(HOST_COMMANDS.lsofFields)]: { failure: "exit-nonzero", stdout: "", stderr: "" },
    });
    const result = await call<PortsResult>(portInspect, {});
    expect(result["ownerCoverage"]).toBe("self-only");
    expect(result["sources"][1]).toMatchObject({ ok: true, role: "owners" });
    // The sockets are all still there, all without owners.
    expect(socketsOf(result).length).toBe(17);
    expect(socketsOf(result).every((socket) => !socket["ownerKnown"])).toBe(true);
  });

  test("root sees every owner, and the result says so", async () => {
    _setHostFacts(macFacts({ uid: 0 }));
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<PortsResult>(portInspect, {});
    expect(result["ownerCoverage"]).toBe("all");
  });

  test("Linux: ss lists a socket it may not name, and it stays in the list", async () => {
    _setHostFacts(facts());
    _setFs(fsWith(LINUX_FILES));
    useRunner(LINUX_COMMANDS);
    const result = await call<PortsResult>(portInspect, { ports: [631, 4000] });
    const cups = socketsOf(result).find((s) => s.port === 631);
    expect(cups).toMatchObject({ ownerKnown: false });
    expect(socketsOf(result).find((s) => s.port === 80)["owners"].length).toBe(2);
    expect(result["socketCoverage"]).toBe("all-users");
    // ss sees every socket, so a port with no row really is free.
    expect(result["queried"][1]).toEqual({ port: 4000, listening: false, listeners: [] });
    expect(unknownFor(result, "sockets[].owners")["reason"]).toContain("not omitted");
  });

  test("Linux without iproute2 falls back to netstat", async () => {
    _setHostFacts(facts());
    _setFs(fsWith(LINUX_FILES));
    const { calls } = useRunner({ [cmd(HOST_COMMANDS.netstatLinux)]: F.LINUX_NETSTAT_LTNP });
    const result = await call<PortsResult>(portInspect, {});
    expect(calls.map((c) => c[0])).toEqual(["ss", "netstat"]);
    expect(socketsOf(result).map((s) => s.port)).toEqual([8080, 9090]);
    expect(result["sources"][0]).toMatchObject({ probe: "ss -ltnp", ok: false });
  });

  test("with neither tool, /proc answers — and BOTH files are read", async () => {
    // Captured together: /proc/net/tcp was header-only while two listeners
    // sat in tcp6. Reading one file would have reported an idle machine.
    _setHostFacts(facts());
    _setFs(
      fsWith({
        ...LINUX_FILES,
        "/proc/net/tcp": F.LINUX_PROC_NET_TCP_EMPTY,
        "/proc/net/tcp6": F.LINUX_PROC_NET_TCP6,
      }),
    );
    useRunner({});
    const result = await call<PortsResult>(portInspect, { ports: [8080] });
    expect(socketsOf(result).map((s) => s.port)).toEqual([8080, 9090]);
    expect(result["queried"][0]["listening"]).toBe(true);
    expect(result["sockets"][0]["owners"][0]).toEqual({ uid: 10001 });
    expect(fieldsOf(result)).toContain("sockets[].owners[].process");
  });

  test("only one of the two proc files readable means coverage is unknown", async () => {
    _setHostFacts(facts());
    _setFs(fsWith({ "/proc/net/tcp": F.LINUX_PROC_NET_TCP }));
    useRunner({});
    const result = await call<PortsResult>(portInspect, { ports: [9090] });
    expect(result["socketCoverage"]).toBeNull();
    expect(result["queried"][0]["listening"]).toBeNull();
  });

  test("Windows: netstat gives the pid, tasklist gives the name", async () => {
    _setHostFacts(windowsFacts());
    _setFs(EMPTY_FS);
    useRunner({
      [cmd(HOST_COMMANDS.netstatWindows)]: F.WINDOWS_NETSTAT_ANO,
      [cmd(HOST_COMMANDS.tasklist)]: F.WINDOWS_TASKLIST_CSV,
    });
    const result = await call<PortsResult>(portInspect, { ports: [445] });
    expect(result["ownerCoverage"]).toBe("all");
    expect(result["queried"][0]["listeners"][0]["owners"][0]).toEqual({
      pid: 4,
      process: "System",
    });
  });

  test("Windows without tasklist keeps the pid and says the name is missing", async () => {
    _setHostFacts(windowsFacts());
    _setFs(EMPTY_FS);
    useRunner({ [cmd(HOST_COMMANDS.netstatWindows)]: F.WINDOWS_NETSTAT_ANO });
    const result = await call<PortsResult>(portInspect, {});
    expect(result["sockets"][0]["owners"][0]["pid"]).toBe(968);
    expect(result["sockets"][0]["ownerKnown"]).toBe(false);
    const entry = unknownFor(result, "sockets[].owners[].process");
    expect(entry["reason"]).toContain("not installed");
    expect(entry["reason"]).toContain("pid is still reported");
  });

  test("a socket list cut short at the cap cannot call a port free", async () => {
    // `netstat -an -p tcp` lists every socket in EVERY state, so a busy host
    // overruns the runner's output cap and what comes back is a PREFIX.
    // Parsed and reported as a whole answer it says "all-users", and the
    // ports whose rows were cut off come back `listening: false` — a free
    // port that is not free, which is the one claim this package exists not
    // to make. Port 631 is in the prefix; 22 is one of the rows that was
    // dropped, and it must read as unknown rather than as free.
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    const prefix = F.MACOS_NETSTAT_TCP.split("\n").slice(0, 14).join("\n");
    useRunner({
      ...MACOS_COMMANDS,
      [cmd(HOST_COMMANDS.netstatBsd)]: { stdout: prefix, truncated: true },
    });
    const result = await call<PortsResult>(portInspect, { ports: [631, 22] });
    expect(result["socketCoverage"]).toBeNull();
    expect(result["queried"]).toEqual([
      { port: 22, listening: null, listeners: [] },
      expect.objectContaining({ port: 631, listening: true }),
    ]);
    expect(unknownFor(result, "socketCoverage").reason).toContain("cut short");
    expect(result["sources"][0]).toMatchObject({ probe: "netstat -an -p tcp", ok: true });
  });

  test("a probe that answered with something else is not an idle machine", async () => {
    // `ss` exited 0 and printed something this parser finds no socket in —
    // a wrapper's warning, a build with different columns, a stub. Zero
    // parsed rows there is NOT "nothing is listening": ss prints its
    // `State Recv-Q …` header even on an idle host, and without it the
    // ladder must move on rather than answer. Before, this reported
    // coverage "all-users" and told the caller ports 22 and 443 were free.
    _setHostFacts(facts());
    _setFs(EMPTY_FS);
    useRunner({ [cmd(HOST_COMMANDS.ss)]: "Cannot open netlink socket: Permission denied\n" });
    const result = await call<PortsResult>(portInspect, { ports: [22, 443] });
    expect(result["sockets"]).toBeNull();
    expect(result["socketCoverage"]).toBeNull();
    expect(result["queried"]).toEqual([
      { port: 22, listening: null, listeners: [] },
      { port: 443, listening: null, listeners: [] },
    ]);
    expect(result["sources"][0]).toMatchObject({
      probe: "ss -ltnp",
      ok: false,
      reason: expect.stringContaining("was not in the form this parser reads"),
    });
  });

  test("an idle host still reports nothing listening, on the strength of the header", () => {
    // The other half of the rule above, and the reason it is a header check
    // rather than "zero rows is never an answer": a host with nothing
    // listening is a real state, and `ss` says so with a bare header row.
    _setHostFacts(facts());
    _setFs(EMPTY_FS);
    useRunner({
      [cmd(HOST_COMMANDS.ss)]:
        "State    Recv-Q   Send-Q     Local Address:Port       Peer Address:Port  Process\n",
    });
    return call<PortsResult>(portInspect, { ports: [22] }).then((result) => {
      expect(result["sockets"]).toEqual([]);
      expect(result["socketCoverage"]).toBe("all-users");
      expect(result["queried"]).toEqual([{ port: 22, listening: false, listeners: [] }]);
    });
  });

  test("Windows: a pid tasklist did not list keeps the attribution honest", async () => {
    // tasklist answered, and the pid holding port 5939 is not in it — the
    // process exited between the two commands, or this user may not see it.
    // Reporting `ownerCoverage: "all"` there presents a gap as a complete
    // attribution of every socket on the machine.
    _setHostFacts(windowsFacts());
    _setFs(EMPTY_FS);
    const withoutTeamViewer = F.WINDOWS_TASKLIST_CSV.split("\r\n")
      .filter((row) => !row.includes("6208"))
      .join("\r\n");
    useRunner({
      [cmd(HOST_COMMANDS.netstatWindows)]: F.WINDOWS_NETSTAT_ANO,
      [cmd(HOST_COMMANDS.tasklist)]: withoutTeamViewer,
    });
    const result = await call<PortsResult>(portInspect, { ports: [5939] });
    expect(result["ownerCoverage"]).toBe("self-only");
    expect(result["queried"][0]["listeners"][0]).toMatchObject({
      ownerKnown: false,
      owners: [{ pid: 6208 }],
    });
    expect(unknownFor(result, "sockets[].owners[].process").reason).toContain(
      "exited between the two commands",
    );
  });

  test("when no probe answers, sockets is null — NOT an idle machine", async () => {
    _setHostFacts(facts());
    _setFs(EMPTY_FS);
    useRunner({});
    const result = await call<PortsResult>(portInspect, { ports: [3000] });
    expect(result["sockets"]).toBeNull();
    expect(result["socketCoverage"]).toBeNull();
    expect(result["queried"][0]["listening"]).toBeNull();
    expect(unknownFor(result, "sockets")["reason"]).toContain(
      "NOT a machine with nothing listening",
    );
  });

  test("the list is capped and says it was", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const result = await call<PortsResult>(portInspect, { limit: 3 });
    expect(result["sockets"].length).toBe(3);
    expect(result["truncated"]).toEqual({ returned: 3, total: 17 });
  });

  test("results are ordered by port, so two calls agree byte for byte", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    useRunner(MACOS_COMMANDS);
    const first = await portInspect.execute({});
    const second = await portInspect.execute({});
    expect(first).toBe(second);
    const ports = (JSON.parse(first) as PortsResult).sockets?.map((s) => s.port) ?? [];
    expect(ports).toEqual([...ports].sort((a: number, b: number) => a - b));
  });
});

// ---------------------------------------------------------------------------
// the two invariants
// ---------------------------------------------------------------------------

/** Resolve a dotted path against a result, for the inverse check below. */
function valueAt(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Every path in `value` that holds null, with array indices collapsed to
 *  `[]` so `sockets.3.owners.0.pid` reads as `sockets[].owners[].pid` — the
 *  form the `unknown` entries use. */
function nullPaths(value: unknown, prefix = ""): string[] {
  if (value === null) return [prefix];
  if (Array.isArray(value)) return value.flatMap((item) => nullPaths(item, `${prefix}[]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      key === "unknown" ? [] : nullPaths(item, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [];
}

describe("every null is explained", () => {
  /** Each scenario is a machine and a tool call against it. */
  const scenarios: Array<[string, () => void, () => Promise<Record<string, unknown>>]> = [
    [
      "a Mac with everything working",
      () => {
        _setHostFacts(macFacts());
        _setFs(EMPTY_FS);
        useRunner(MACOS_COMMANDS);
      },
      () =>
        call<SystemResult>(systemInfo, {
          sections: ["os", "cpu", "memory", "uptime", "runtime", "battery"],
        }),
    ],
    [
      "a Mac with no probes installed at all",
      () => {
        _setHostFacts(
          macFacts({ cpus: [], totalMemBytes: 0, freeMemBytes: 0, uptimeSeconds: 0, hostname: "" }),
        );
        _setFs(EMPTY_FS);
        useRunner({});
      },
      () =>
        call<SystemResult>(systemInfo, {
          sections: ["os", "cpu", "memory", "uptime", "runtime", "battery"],
        }),
    ],
    [
      "a container where the runtime sees no CPUs but /proc does",
      () => {
        _setHostFacts(facts({ cpus: [] }));
        _setFs(fsWith(LINUX_FILES));
        useRunner(LINUX_COMMANDS);
      },
      () => call(systemInfo, { sections: ["os", "cpu", "memory", "uptime", "runtime"] }),
    ],
    [
      "a Windows host",
      () => {
        _setHostFacts(windowsFacts());
        _setFs(EMPTY_FS);
        useRunner({ [cmd(HOST_COMMANDS.wmicBattery)]: F.WINDOWS_WMIC_BATTERY });
      },
      () => call<SystemResult>(systemInfo, { sections: ["os", "cpu", "memory", "battery"] }),
    ],
    [
      "a Linux host with no interface probe",
      () => {
        _setHostFacts(facts({ dnsServers: [] }));
        _setFs(EMPTY_FS);
        useRunner({});
      },
      () => call<NetworkResult>(networkInfo, {}),
    ],
    [
      "a Linux host with iproute2",
      () => {
        _setHostFacts(facts());
        _setFs(fsWith(LINUX_FILES));
        useRunner(LINUX_COMMANDS);
      },
      () => call<NetworkResult>(networkInfo, {}),
    ],
    [
      "a Mac with sockets but few owners",
      () => {
        _setHostFacts(macFacts());
        _setFs(EMPTY_FS);
        useRunner(MACOS_COMMANDS);
      },
      () => call<PortsResult>(portInspect, { ports: [631, 9999] }),
    ],
    [
      "a host where nothing at all answered",
      () => {
        _setHostFacts(facts());
        _setFs(EMPTY_FS);
        useRunner({});
      },
      () => call<PortsResult>(portInspect, { ports: [3000] }),
    ],
    [
      // The disk section was outside every scenario above, so the guard had
      // never walked a `disk` object at all — and a statfs whose numbers are
      // refused is exactly where its nulls come from.
      "a filesystem whose statfs answers with numbers this tool refuses",
      () => {
        _setHostFacts(facts());
        _setFs(fsWith({}, {}, () => ({ bsize: 0, blocks: 0, bfree: 0, bavail: 0 })));
        useRunner({});
      },
      () => call<SystemResult>(systemInfo, { sections: [], diskPath: "." }),
    ],
    [
      "a laptop whose battery device cannot be read",
      () => {
        _setHostFacts(facts());
        _setFs(fsWith({}, { "/sys/class/power_supply": ["BAT0"] }));
        useRunner({});
      },
      () => call<SystemResult>(systemInfo, { sections: ["battery"] }),
    ],
    [
      "a Mac whose socket table was cut short at the cap",
      () => {
        _setHostFacts(macFacts());
        _setFs(EMPTY_FS);
        useRunner({
          ...MACOS_COMMANDS,
          [cmd(HOST_COMMANDS.netstatBsd)]: {
            stdout: F.MACOS_NETSTAT_TCP.slice(0, 600),
            truncated: true,
          },
        });
      },
      () => call<PortsResult>(portInspect, { ports: [22, 631] }),
    ],
    [
      // The runtime's table is the only source that renders nulls per row,
      // and a virtual adapter with no hardware address adds a fourth.
      "a Windows host answered only by the runtime's interface table",
      () => {
        _setHostFacts(
          windowsFacts({
            dnsServers: [],
            interfaces: {
              Wintun: [
                { address: "10.2.0.2", family: "IPv4", internal: false, netmask: "255.255.255.0" },
              ],
            },
          }),
        );
        _setFs(EMPTY_FS);
        useRunner({});
      },
      () => call<NetworkResult>(networkInfo, {}),
    ],
    [
      "a Linux host whose only ifconfig is busybox's",
      () => {
        _setHostFacts(facts({ interfaces: {} }));
        _setFs(EMPTY_FS);
        useRunner({ [cmd(HOST_COMMANDS.ifconfig)]: F.LINUX_IFCONFIG_BUSYBOX });
      },
      () => call<NetworkResult>(networkInfo, {}),
    ],
    [
      "a slim container, /proc only",
      () => {
        _setHostFacts(facts({ cpus: [] }));
        _setFs(fsWith({ "/proc/net/tcp6": F.LINUX_PROC_NET_TCP6 }));
        useRunner({});
      },
      () => call<PortsResult>(portInspect, { ports: [8080] }),
    ],
  ];

  /** How many nulls the scenarios actually produced. A guard that never
   *  sees the thing it guards against passes for the wrong reason, so the
   *  count is asserted at the end rather than assumed. */
  let nullsSeen = 0;

  for (const [name, arrange, act] of scenarios) {
    test(name, async () => {
      arrange();
      const result = await act();
      const explained = new Set(
        (result["unknown"] as Array<{ field: string }>).map((u) => u.field),
      );
      const paths = nullPaths(result);
      nullsSeen += paths.length;
      const unexplained = paths.filter((path) => !explained.has(path));
      // A null with no entry is the defect this package is about: a caller
      // reading it cannot tell "not measured" from "measured as nothing".
      expect({ scenario: name, unexplained }).toEqual({ scenario: name, unexplained: [] });
      // …and every reason names a probe, so the caller can do something.
      for (const entry of result["unknown"] as Array<{ probe: string; reason: string }>) {
        expect(entry.probe.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(10);
      }

      // The inverse, which has caught two real bugs: an entry saying a field
      // is unknown while the field sits next to it with a value. A probe
      // failing does not make a fact unknown when another probe answered it.
      const contradictions = (result["unknown"] as Array<{ field: string }>)
        .map((u) => u.field)
        // A `[]` path is about a class of rows ("some socket has no owner"),
        // not about one value, so it has nothing to resolve against.
        .filter((field) => !field.includes("[]"))
        .filter((field) => {
          const value = valueAt(result, field);
          return value !== undefined && value !== null;
        });
      expect({ scenario: name, contradictions }).toEqual({ scenario: name, contradictions: [] });
    });
  }

  test("the scenarios above really do produce nulls", () => {
    // Without this the whole block passes on a day when every field happens
    // to be filled in — a guard that never fires is not a guard.
    expect(nullsSeen).toBeGreaterThan(15);
  });
});

describe("argv is a constant", () => {
  const ADVERSARIAL = [
    "-rf",
    "--exclude=/",
    "; rm -rf /",
    "$(whoami)",
    "`id`",
    "a b\nc",
    "../../etc/passwd",
    "--",
    " ",
  ];

  test("no caller value reaches a command line", async () => {
    // The repo has shipped argument injection once: gitBranchCreate({name:
    // "-D"}) ran `git branch -D victim`. Here there is nothing to inject
    // into — every argv is a literal from HOST_COMMANDS — and this replays
    // hostile input against a recording runner to prove it.
    const seen: string[][] = [];
    for (const value of ADVERSARIAL) {
      _setHostFacts(macFacts());
      _setFs(EMPTY_FS);
      const { calls } = useRunner(MACOS_COMMANDS);
      await systemInfo.execute({ diskPath: value, sections: ["os", "cpu", "battery"] });
      await networkInfo.execute({ interfaceName: value });
      await portInspect.execute({ limit: 5 });
      seen.push(...calls);
    }

    const permitted = new Set(Object.values(HOST_COMMANDS).map((argv) => argv.join(" ")));
    const built = seen.filter((argv) => !permitted.has(argv.join(" ")));
    expect(built).toEqual([]);
    // And the hostile strings appear nowhere in any argv, in any form.
    const flat = seen.flat().join(" ");
    for (const value of ADVERSARIAL) expect(flat).not.toContain(value.trim());
    expect(seen.length).toBeGreaterThan(0);
  });

  test("a port number is matched in JavaScript, never passed to a command", async () => {
    _setHostFacts(macFacts());
    _setFs(EMPTY_FS);
    const { calls } = useRunner(MACOS_COMMANDS);
    await portInspect.execute({ ports: [22, 65535, 0] });
    expect(calls).toEqual([[...HOST_COMMANDS.netstatBsd], [...HOST_COMMANDS.lsofFields]]);
  });

  test("the command table is frozen, so nothing can be appended at runtime", () => {
    expect(Object.isFrozen(HOST_COMMANDS)).toBe(true);
    expect(Object.isFrozen(HOST_COMMANDS.lsofFields)).toBe(true);
    expect(() => {
      (HOST_COMMANDS.uname as string[]).push("--evil");
    }).toThrow();
  });
});

describe("the tool contracts", () => {
  test("all three are read-only, concurrency-safe and declare that they spawn", () => {
    for (const tool of HOST_TOOLS) {
      expect({
        name: tool.name,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        concurrencySafe: tool.concurrencySafe,
        scope: tool.scope,
        ioCapability: tool.ioCapability,
      }).toEqual({
        name: tool.name,
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
        // Declared because they run commands: the scope audit requires
        // "external" of anything that declares an io-capability.
        scope: "external",
        ioCapability: "process",
      });
    }
  });

  test("the schemas reject what they should", () => {
    expect(portInspect.inputSchema.safeParse({ ports: ["-rf"] }).success).toBe(false);
    expect(portInspect.inputSchema.safeParse({ ports: [70000] }).success).toBe(false);
    expect(portInspect.inputSchema.safeParse({ ports: [22] }).success).toBe(true);
    expect(systemInfo.inputSchema.safeParse({ sections: ["kernel"] }).success).toBe(false);
    expect(systemInfo.inputSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
    expect(networkInfo.inputSchema.safeParse({}).success).toBe(true);
  });
});
