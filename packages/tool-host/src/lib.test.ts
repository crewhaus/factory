/**
 * The parsers, against recorded output.
 *
 * Nothing in this file runs a command, reads /proc or touches a socket. Each
 * test drives a string from ../fixtures.ts — real bytes from a macOS host and
 * a real Linux container, plus the documented formats for the tools no
 * machine here can run. That is deliberate: CI is Linux and development is
 * macOS, so a parser checked against "whatever this host prints" is a parser
 * with no test at all.
 */
import { describe, expect, test } from "bun:test";
import * as F from "./fixtures";
import {
  dottedNetmaskToPrefix,
  hexNetmaskToPrefix,
  interfacesFromOsMap,
  parseIfconfig,
  parseIpAddrText,
  parseIpJson,
  parseResolvConf,
  proxyFromEnv,
  redactProxyUrl,
} from "./lib/network";
import {
  decodeLsofName,
  dedupeSockets,
  familyOf,
  formatIpv6,
  hexToIpv4,
  hexToIpv6,
  joinOwners,
  looksLikeNetstatOutput,
  looksLikeProcNetTcp,
  looksLikeSsOutput,
  looksLikeWindowsNetstatOutput,
  normalizeAddress,
  parseBsdNetstat,
  parseLinuxNetstat,
  parseLsofColumns,
  parseLsofFields,
  parseProcNetTcp,
  parseSsListen,
  parseSsUsers,
  parseTasklistCsv,
  parseWindowsNetstat,
  sortSockets,
  splitColonPort,
  splitDotPort,
} from "./lib/ports";
import {
  chooseSystemBattery,
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
import { Unknowns, failureReason, firstLine } from "./lib/unknown";

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe("uname", () => {
  test("the version field keeps its spaces and colons", () => {
    const parsed = parseUname(F.MACOS_UNAME);
    expect(parsed).toMatchObject({
      kernelName: "Darwin",
      kernelRelease: "25.6.0",
      machine: "arm64",
    });
    // Splitting into four fields would stop at "Darwin" and report a date
    // fragment as the machine.
    expect(parsed?.kernelVersion).toContain("xnu-12377.161.14~5/RELEASE_ARM64_T8103");
    expect(parsed?.kernelVersion).toContain("Fri Jul 31 19:17:12 PDT 2026");
  });

  test("a plain Linux uname parses the same way", () => {
    const parsed = parseUname(
      "Linux 6.8.0-40-generic #40-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 5 10:34:03 UTC 2026 x86_64\n",
    );
    expect(parsed).toMatchObject({
      kernelName: "Linux",
      kernelRelease: "6.8.0-40-generic",
      machine: "x86_64",
    });
  });

  test("output too short to be uname is null, not a partial guess", () => {
    expect(parseUname("")).toBeNull();
    expect(parseUname("Darwin 25.6.0")).toBeNull();
  });
});

describe("sw_vers", () => {
  test("the two-tab separator does not become part of the value", () => {
    expect(parseSwVers(F.MACOS_SW_VERS)).toEqual({
      productName: "macOS",
      productVersion: "26.6.2",
      buildVersion: "25G83",
    });
  });

  test("a Rapid Security Response suffix is kept with the version", () => {
    const parsed = parseSwVers(
      "ProductName:\tmacOS\nProductVersion:\t14.4.1\nProductVersionExtra:\t(a)\nBuildVersion:\t23E224\n",
    );
    expect(parsed.productVersion).toBe("14.4.1 (a)");
  });

  test("missing keys are null rather than empty strings", () => {
    expect(parseSwVers("")).toEqual({
      productName: null,
      productVersion: null,
      buildVersion: null,
    });
  });
});

describe("colon pairs", () => {
  test("a value containing colons survives (kern.boottime prints a time)", () => {
    const pairs = parseColonPairs(F.MACOS_SYSCTL);
    expect(pairs.get("hw.memsize")).toBe("17179869184");
    expect(pairs.get("machdep.cpu.brand_string")).toBe("Apple M1");
    expect(pairs.get("kern.boottime")).toBe(
      "{ sec = 1789196391, usec = 979990 } Fri Sep 11 23:59:51 2026",
    );
  });

  test("named output is why `sysctl -n` is not used", () => {
    // Five keys were asked for and four values came back, because
    // hw.cpufrequency does not exist on Apple Silicon. Zipping the lines
    // against the key list reads the memory size as the physical core count.
    const lines = F.MACOS_SYSCTL_N_MISALIGNED.trim().split("\n");
    const asked = [
      "hw.logicalcpu",
      "hw.physicalcpu",
      "hw.memsize",
      "machdep.cpu.brand_string",
      "hw.cpufrequency",
    ];
    expect(lines.length).toBe(asked.length - 1);
    const zipped = Object.fromEntries(asked.map((key, i) => [key, lines[i]]));
    expect(zipped["machdep.cpu.brand_string"]).toBe("Apple M1");
    // …but the named form is not fooled:
    expect(parseColonPairs(F.MACOS_SYSCTL).get("machdep.cpu.brand_string")).toBe("Apple M1");
    expect(parseColonPairs(F.MACOS_SYSCTL).get("hw.physicalcpu")).toBe("8");
  });

  test("a trailing carriage return is stripped from Windows output", () => {
    expect(parseColonPairs("Key: value\r\nOther: 2\r\n").get("Key")).toBe("value");
  });
});

describe("os-release", () => {
  test("quoted values are unquoted, unquoted ones are left alone", () => {
    const alpine = parseEqualsPairs(F.LINUX_OS_RELEASE_ALPINE);
    expect(alpine.get("NAME")).toBe("Alpine Linux");
    expect(alpine.get("ID")).toBe("alpine");
    expect(alpine.get("VERSION_ID")).toBe("3.20.7");
  });

  test("a value with spaces and parentheses survives", () => {
    expect(parseEqualsPairs(F.LINUX_OS_RELEASE_DEBIAN).get("PRETTY_NAME")).toBe(
      "Debian GNU/Linux 13 (trixie)",
    );
  });

  test("comments are skipped and escapes inside quotes are unescaped", () => {
    const pairs = parseEqualsPairs('# a comment\nNAME="a \\"quoted\\" name"\n');
    expect(pairs.get("NAME")).toBe('a "quoted" name');
  });
});

// ---------------------------------------------------------------------------
// cpu and memory
// ---------------------------------------------------------------------------

describe("/proc/cpuinfo", () => {
  test("an ARM kernel names no model and no topology, and neither is invented", () => {
    // Captured from a real aarch64 container. There is no `model name` line
    // and no `physical id`/`core id` pair anywhere in the file.
    expect(parseProcCpuinfo(F.LINUX_PROC_CPUINFO_ARM64)).toEqual({
      logicalCores: 4,
      physicalCores: null,
      model: null,
    });
  });

  test("x86 topology counts physical cores, which is half of logical here", () => {
    expect(parseProcCpuinfo(F.LINUX_PROC_CPUINFO_X86)).toEqual({
      logicalCores: 4,
      physicalCores: 2,
      model: "Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz",
    });
  });

  test("an unreadable or empty file is null cores, never zero cores", () => {
    expect(parseProcCpuinfo("")).toEqual({ logicalCores: null, physicalCores: null, model: null });
  });

  test("a partial topology does not produce a partial count", () => {
    // One processor block carries physical id/core id and one does not.
    // Counting only the complete blocks would report 1 physical core on a
    // machine with two.
    const text = "processor\t: 0\nphysical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 1\n";
    expect(parseProcCpuinfo(text).physicalCores).toBeNull();
  });
});

describe("/proc/meminfo", () => {
  test("kB values become bytes and MemAvailable is not MemFree", () => {
    const parsed = parseProcMeminfo(F.LINUX_PROC_MEMINFO);
    expect(parsed.totalBytes).toBe(13280532 * 1024);
    expect(parsed.freeBytes).toBe(11001140 * 1024);
    expect(parsed.availableBytes).toBe(12351268 * 1024);
    expect(parsed.availableBytes).not.toBe(parsed.freeBytes);
  });

  test("a kernel without MemAvailable reports null, not MemFree", () => {
    const parsed = parseProcMeminfo(F.LINUX_PROC_MEMINFO_NO_AVAILABLE);
    expect(parsed.availableBytes).toBeNull();
    expect(parsed.freeBytes).toBe(131072 * 1024);
  });

  test("an unexpected unit is refused rather than multiplied on a guess", () => {
    expect(parseProcMeminfo("MemTotal:  2048 pages\n").totalBytes).toBeNull();
    expect(parseProcMeminfo("MemTotal:  2048 MB\n").totalBytes).toBe(2048 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// battery
// ---------------------------------------------------------------------------

describe("battery", () => {
  test("a Mac with no battery is present:false, and never 0%", () => {
    // The whole captured output is one line, with no battery line at all.
    const parsed = parsePmsetBatt(F.MACOS_PMSET_NO_BATTERY);
    expect(parsed).toEqual({ present: false, percent: null, charging: null, powerSource: "ac" });
    expect(parsed.percent).not.toBe(0);
  });

  test("discharging is not charging, though it contains the word", () => {
    expect(parsePmsetBatt(F.MACOS_PMSET_DISCHARGING)).toEqual({
      present: true,
      percent: 63,
      charging: false,
      powerSource: "battery",
    });
  });

  test("charging with no time estimate still reads as charging", () => {
    expect(parsePmsetBatt(F.MACOS_PMSET_CHARGING)).toMatchObject({
      percent: 41,
      charging: true,
      powerSource: "ac",
    });
  });

  test("charged on mains is charging:false — a measurement, not an unknown", () => {
    expect(parsePmsetBatt(F.MACOS_PMSET_CHARGED)).toMatchObject({
      present: true,
      percent: 100,
      charging: false,
    });
  });

  test("pmset's own present:false wins over the presence of a battery line", () => {
    const text =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t0%; discharging; 0:00 remaining present: false\n";
    expect(parsePmsetBatt(text)).toMatchObject({ present: false, percent: null });
  });

  test("sysfs: discharging at 87%", () => {
    expect(
      parseSysfsBattery(F.LINUX_SYSFS_BATTERY_CAPACITY, F.LINUX_SYSFS_BATTERY_STATUS_DISCHARGING),
    ).toEqual({ present: true, percent: 87, charging: false, powerSource: "battery" });
  });

  test("sysfs: 'Not charging' under a charge limiter is unknown, not false", () => {
    const parsed = parseSysfsBattery(
      F.LINUX_SYSFS_BATTERY_CAPACITY,
      F.LINUX_SYSFS_BATTERY_STATUS_NOT_CHARGING,
    );
    expect(parsed.charging).toBeNull();
    expect(parsed.percent).toBe(87);
  });

  test("sysfs: no files at all is present:null, not present:false", () => {
    expect(parseSysfsBattery(undefined, undefined)).toEqual({
      present: null,
      percent: null,
      charging: null,
      powerSource: null,
    });
  });

  test("wmic: status 2 is on mains with an undetermined charge direction", () => {
    expect(parseWmicBattery(F.WINDOWS_WMIC_BATTERY)).toEqual({
      present: true,
      percent: 87,
      charging: null,
      powerSource: "ac",
    });
  });

  test("wmic: charging and discharging codes are distinguished", () => {
    expect(parseWmicBattery("BatteryStatus=6\r\nEstimatedChargeRemaining=50\r\n").charging).toBe(
      true,
    );
    expect(parseWmicBattery("BatteryStatus=1\r\nEstimatedChargeRemaining=50\r\n")).toMatchObject({
      charging: false,
      powerSource: "battery",
    });
  });

  test("wmic: no instance means no battery, which IS a measurement", () => {
    expect(parseWmicBattery(F.WINDOWS_WMIC_BATTERY_NONE).present).toBe(false);
  });

  test("a percentage outside 0..100 is a misread and comes back null", () => {
    expect(parseSysfsBattery("173\n", "Discharging\n").percent).toBeNull();
    expect(parseSysfsBattery("0\n", "Discharging\n").percent).toBe(0);
  });

  test("pmset: a battery held by a charge limiter is NOT charging", () => {
    // "not charging" contains "charging" as a whole word with a space in
    // front of it, so the word-boundary guard that keeps "discharging" out
    // lets this one straight through. macOS prints it for every battery
    // Optimized Battery Charging or an 80% cap is holding below full: on
    // mains, filling nothing, draining nothing. `true` would tell a caller
    // to wait for a charge that will never arrive, and `false` would say
    // the machine is running down — so the direction is unknown, exactly as
    // Linux's identical "Not charging" is read from sysfs above.
    const parsed = parsePmsetBatt(F.MACOS_PMSET_NOT_CHARGING);
    expect(parsed).toEqual({
      present: true,
      percent: 80,
      charging: null,
      powerSource: "ac",
    });
  });

  test("the system battery is chosen by the kernel's attributes, not by its name", () => {
    // A desktop with a Logitech mouse: /sys/class/power_supply holds the
    // mouse's cell as `hidpp_battery_0`, type Battery, scope Device. Picked
    // by name, that desktop reports itself as running on battery at the
    // charge of a MOUSE — and the catalog's own example use ("skip the 8 GB
    // pull below 20% battery") then fires on a peripheral.
    const attrs: Record<string, Record<string, string>> = {
      AC: { type: "Mains" },
      hidpp_battery_0: { type: "Battery", scope: "Device", capacity: "12" },
    };
    const read = (device: string, attribute: string): string | undefined =>
      attrs[device]?.[attribute];
    expect(chooseSystemBattery(["AC", "hidpp_battery_0"], read)).toBeNull();

    // The same directory on a laptop, where the system battery is present.
    attrs["BAT0"] = { type: "Battery", capacity: "87" };
    expect(chooseSystemBattery(["AC", "BAT0", "hidpp_battery_0"], read)).toBe("BAT0");
  });

  test("a battery whose type cannot be read is accepted only under a slot name", () => {
    const none = (): string | undefined => undefined;
    // Asahi Linux calls it macsmc-battery; x86 calls it BAT0 or CMB0.
    expect(chooseSystemBattery(["BAT1"], none)).toBe("BAT1");
    expect(chooseSystemBattery(["macsmc-battery"], none)).toBe("macsmc-battery");
    // No system battery is called this, and guessing from the word
    // "battery" is what put a mouse on the result in the first place.
    expect(chooseSystemBattery(["sony_controller_battery_00"], none)).toBeNull();
  });
});

describe("statfs", () => {
  test("available is smaller than free, and both are reported", () => {
    // The gap is the reserved-block pool only root may use. Gating a write
    // on `free` is how a job hits ENOSPC with 5% still "free".
    const disk = statfsToBytes({ bsize: 4096, blocks: 1_000_000, bfree: 100_000, bavail: 48_000 });
    expect(disk).toEqual({
      totalBytes: 4096 * 1_000_000,
      freeBytes: 4096 * 100_000,
      availableBytes: 4096 * 48_000,
    });
  });

  test("a failed reading is null everywhere, not an empty disk", () => {
    expect(statfsToBytes(undefined)).toEqual({
      totalBytes: null,
      freeBytes: null,
      availableBytes: null,
    });
    expect(statfsToBytes({ bsize: 0, blocks: 0, bfree: 0, bavail: 0 }).totalBytes).toBeNull();
  });

  test("a negative count is refused (APFS returns negative inode figures)", () => {
    const disk = statfsToBytes({ bsize: 4096, blocks: 100, bfree: -5, bavail: -5 });
    expect(disk.totalBytes).toBe(409_600);
    expect(disk.freeBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// interfaces
// ---------------------------------------------------------------------------

describe("netmasks", () => {
  test("BSD hex masks become prefix lengths", () => {
    expect(hexNetmaskToPrefix("0xff000000")).toBe(8);
    expect(hexNetmaskToPrefix("0xffffff00")).toBe(24);
    expect(hexNetmaskToPrefix("0xffffffff")).toBe(32);
    expect(hexNetmaskToPrefix("0x00000000")).toBe(0);
  });

  test("a non-contiguous mask is not a prefix and is refused", () => {
    expect(hexNetmaskToPrefix("0xffff00ff")).toBeNull();
    expect(dottedNetmaskToPrefix("255.255.0.255")).toBeNull();
  });

  test("dotted masks work too, and nonsense is refused", () => {
    expect(dottedNetmaskToPrefix("255.255.255.0")).toBe(24);
    expect(dottedNetmaskToPrefix("255.255.255")).toBeNull();
    expect(dottedNetmaskToPrefix("300.0.0.0")).toBeNull();
  });
});

describe("ifconfig", () => {
  const interfaces = parseIfconfig(F.MACOS_IFCONFIG);
  const byName = new Map(interfaces.map((i) => [i.name, i]));

  test("bridge0's indented Configuration: and member: lines are not interfaces", () => {
    expect(interfaces.map((i) => i.name)).toEqual([
      "lo0",
      "gif0",
      "stf0",
      "en0",
      "bridge0",
      "en1",
      "utun0",
    ]);
    expect(byName.has("member")).toBe(false);
    expect(byName.has("Configuration")).toBe(false);
  });

  test("UP with no carrier is reported as both facts, not collapsed", () => {
    // en0 is administratively up and has nothing plugged in. One boolean
    // cannot say that, which is why there are two fields.
    expect(byName.get("en0")).toMatchObject({ adminUp: true, link: "inactive" });
    expect(byName.get("en1")).toMatchObject({ adminUp: true, link: "active" });
  });

  test("the hex netmask becomes a prefix length", () => {
    expect(byName.get("en1")?.addresses).toEqual([
      { family: "ipv4", address: "192.168.7.42", prefixLength: 24, scope: null },
    ]);
  });

  test("an IPv6 zone is split out of the address", () => {
    expect(byName.get("utun0")?.addresses[0]).toEqual({
      family: "ipv6",
      address: "fe80::da12:389f:2939:f760",
      prefixLength: 64,
      scope: "link",
      zone: "utun0",
    });
  });

  test("an interface with no status line has an unknown carrier, not a false one", () => {
    expect(byName.get("lo0")?.link).toBeNull();
    expect(byName.get("lo0")).toMatchObject({ loopback: true, mtu: 16384 });
  });
});

describe("ifconfig that is not BSD's", () => {
  test("busybox output parses to NOTHING, which is not an empty machine", () => {
    // Captured from a real Alpine container, exit code 0. `parseIfconfig`
    // finds interfaces by the BSD header `en0: flags=8863<...>`; busybox
    // and net-tools print `eth0      Link encap:Ethernet ...` with no
    // `flags=` at all, so nothing here is recognised — and every host has
    // at least a loopback, so zero interfaces can only mean the output was
    // not understood. The tool-level test asserts what NetworkInfo then
    // does with it: null and a stated reason, never `interfaces: []`.
    expect(parseIfconfig(F.LINUX_IFCONFIG_BUSYBOX)).toEqual([]);
    // Not because the fixture is empty: the bytes are there to be read.
    expect(F.LINUX_IFCONFIG_BUSYBOX).toContain("eth0");
    expect(F.LINUX_IFCONFIG_BUSYBOX).toContain("inet addr:172.17.0.2");
  });
});

describe("ip", () => {
  test("`ip -j` is preferred, and its JSON carries typed prefixes and scopes", () => {
    const parsed = parseIpJson(F.LINUX_IP_J_ADDR);
    expect(parsed?.map((i) => i.name)).toEqual(["lo", "enp0s31f6", "wlp2s0"]);
    expect(parsed?.[1]).toMatchObject({
      adminUp: true,
      link: "active",
      mtu: 1500,
      mac: "02:42:ac:11:00:03",
    });
    expect(parsed?.[1]?.addresses[0]).toEqual({
      family: "ipv4",
      address: "10.0.5.17",
      prefixLength: 24,
      scope: "global",
    });
    // A down interface is still listed, with no addresses — the difference
    // between "no interface" and "an interface with nothing on it".
    expect(parsed?.[2]).toMatchObject({ adminUp: false, link: "inactive", addresses: [] });
  });

  test("busybox answers -j with its usage text, which is not an empty machine", () => {
    // Captured: exit 1 and a usage message. Returning [] here would report a
    // host with no interfaces; null makes the caller fall back to `ip addr`.
    expect(parseIpJson(F.LINUX_IP_J_UNSUPPORTED)).toBeNull();
    expect(parseIpJson('{"not":"an array"}')).toBeNull();
  });

  test("the text form: the name stops at the @, and the carrier is LOWER_UP", () => {
    const parsed = parseIpAddrText(F.LINUX_IP_ADDR_TEXT);
    expect(parsed.map((i) => i.name)).toEqual(["lo", "tunl0", "ip6tnl0", "eth0"]);
    // `state UNKNOWN` on loopback is why the state word is not the carrier.
    expect(parsed[0]).toMatchObject({ name: "lo", adminUp: true, link: "active", loopback: true });
    expect(parsed[3]).toMatchObject({ name: "eth0", mtu: 1500, mac: "02:42:ac:11:00:02" });
    expect(parsed[3]?.addresses[0]).toEqual({
      family: "ipv4",
      address: "172.17.0.2",
      prefixLength: 16,
      scope: "global",
    });
  });

  test("a tunnel's link address is not reported as a MAC", () => {
    const parsed = parseIpAddrText(F.LINUX_IP_ADDR_TEXT);
    // `link/ipip 0.0.0.0` and a sixteen-octet `link/tunnel6` address both sit
    // where a MAC would be; neither is one.
    expect(parsed[1]?.mac).toBeNull();
    expect(parsed[2]?.mac).toBeNull();
  });
});

describe("the runtime's interface table", () => {
  test("it is normalised, sorted, and honest about what it cannot say", () => {
    const parsed = interfacesFromOsMap({
      en0: [
        {
          address: "192.168.7.42",
          family: "IPv4",
          internal: false,
          mac: "02:11:22:33:44:61",
          netmask: "255.255.255.0",
          cidr: "192.168.7.42/24",
        },
      ],
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.1/8",
        },
      ],
    });
    // Sorted by name: object key order is the order the OS happened to
    // produce, and a tool that leaks it is not deterministic.
    expect(parsed.map((i) => i.name)).toEqual(["en0", "lo0"]);
    expect(parsed[0]).toMatchObject({ adminUp: null, link: null, mtu: null, loopback: false });
    expect(parsed[0]?.addresses[0]?.prefixLength).toBe(24);
    expect(parsed[1]?.loopback).toBe(true);
  });

  test("a numeric family (newer Node) is read the same as the string form", () => {
    const parsed = interfacesFromOsMap({
      eth0: [{ address: "fe80::1%eth0", family: 6, internal: false, cidr: "fe80::1/64" }],
    });
    expect(parsed[0]?.addresses[0]).toMatchObject({
      family: "ipv6",
      address: "fe80::1",
      zone: "eth0",
      prefixLength: 64,
    });
  });
});

// ---------------------------------------------------------------------------
// dns and proxy
// ---------------------------------------------------------------------------

describe("resolv.conf", () => {
  test("nameservers and the last search line win", () => {
    expect(parseResolvConf(F.LINUX_RESOLV_CONF_SEARCH)).toEqual({
      resolvers: ["127.0.0.53", "10.0.0.1"],
      searchDomains: ["example.com", "internal.example.com"],
    });
  });

  test("a container's file with no search list yields an empty one", () => {
    expect(parseResolvConf(F.LINUX_RESOLV_CONF)).toEqual({
      resolvers: ["192.168.65.5"],
      searchDomains: [],
    });
  });

  test("`domain` is read as a one-entry search list", () => {
    expect(parseResolvConf("domain corp.example.com\n").searchDomains).toEqual([
      "corp.example.com",
    ]);
  });
});

describe("proxy environment", () => {
  test("credentials are removed from the URL", () => {
    expect(redactProxyUrl("http://alice:s3cret@proxy.example.com:3128")).toEqual({
      url: "http://proxy.example.com:3128",
      credentials: "redacted",
    });
  });

  test("a value that is not a URL is still cut at its @", () => {
    const redacted = redactProxyUrl("alice:s3cret@proxy:3128");
    expect(redacted.url).not.toContain("s3cret");
  });

  test("a clean URL is passed through untouched", () => {
    expect(redactProxyUrl("http://proxy.example.com:3128")).toEqual({
      url: "http://proxy.example.com:3128",
      credentials: "none",
    });
  });

  test("the lowercase spelling wins and the disagreement is reported", () => {
    const view = proxyFromEnv({
      http_proxy: "http://good.example:3128",
      HTTP_PROXY: "http://attacker.example:80",
      no_proxy: "localhost, 127.0.0.1 ,*.internal",
    });
    expect(view.http).toMatchObject({ url: "http://good.example:3128", from: "http_proxy" });
    expect(view.conflicts[0]).toContain("CVE-2016-5387");
    expect(view.noProxy).toEqual(["localhost", "127.0.0.1", "*.internal"]);
  });

  test("an unset environment yields nulls and no conflicts", () => {
    expect(proxyFromEnv({})).toEqual({
      http: null,
      https: null,
      all: null,
      noProxy: null,
      conflicts: [],
    });
  });

  test("the uppercase spelling is used when it is the only one", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "http://proxy:8080" }).https).toMatchObject({
      from: "HTTPS_PROXY",
    });
  });
});

// ---------------------------------------------------------------------------
// sockets
// ---------------------------------------------------------------------------

describe("address splitting", () => {
  test("the split is on the LAST colon, because IPv6 is made of colons", () => {
    expect(splitColonPort("0.0.0.0:22")).toEqual({ address: "*", port: 22 });
    expect(splitColonPort(":::9090")).toEqual({ address: "*", port: 9090 });
    expect(splitColonPort("[::]:22")).toEqual({ address: "*", port: 22 });
    expect(splitColonPort("[::1]:631")).toEqual({ address: "::1", port: 631 });
    expect(splitColonPort("127.0.0.53%lo:53")).toEqual({ address: "127.0.0.53", port: 53 });
  });

  test("BSD separates with a dot, IPv6 included", () => {
    expect(splitDotPort("*.8770")).toEqual({ address: "*", port: 8770 });
    expect(splitDotPort("127.0.0.1.631")).toEqual({ address: "127.0.0.1", port: 631 });
    expect(splitDotPort("::1.631")).toEqual({ address: "::1", port: 631 });
    expect(splitDotPort("*.*")).toBeNull();
  });

  test("every spelling of a wildcard normalises to one", () => {
    for (const wildcard of ["*", "0.0.0.0", "::", "[::]"]) {
      expect(normalizeAddress(wildcard)).toBe("*");
    }
    expect(normalizeAddress("127.0.0.1")).toBe("127.0.0.1");
  });

  test("a bare wildcard is dual-stack rather than guessed as v4", () => {
    expect(familyOf("*:80", "*")).toBe("dual");
    expect(familyOf("0.0.0.0:80", "*")).toBe("ipv4");
    expect(familyOf("[::]:80", "*")).toBe("ipv6");
    expect(familyOf("127.0.0.1:80", "127.0.0.1")).toBe("ipv4");
  });

  test("a port is read from digits, not from whatever Number() will coerce", () => {
    // `Number("")` is 0 and `Number("0x16")` is 22, so a field that arrived
    // cut short, or in a form no port is ever written in, would otherwise
    // come back as a genuine-looking port on a genuine-looking address —
    // and a caller reads that as something listening there.
    expect(splitColonPort("127.0.0.1:")).toBeNull();
    expect(splitColonPort("127.0.0.1:0x16")).toBeNull();
    expect(splitColonPort("127.0.0.1: 22")).toBeNull();
    expect(splitColonPort("127.0.0.1:1e3")).toBeNull();
    expect(splitDotPort("127.0.0.1.")).toBeNull();
    expect(splitDotPort("127.0.0.1.0x16")).toBeNull();
    // …and the real forms still parse, including port 0.
    expect(splitColonPort("0.0.0.0:0")).toEqual({ address: "*", port: 0 });
    expect(splitColonPort("0.0.0.0:65535")).toEqual({ address: "*", port: 65535 });
    expect(splitColonPort("0.0.0.0:65536")).toBeNull();
  });
});

describe("was that really the tool's output", () => {
  test("each socket source is recognised by the header it always prints", () => {
    expect(looksLikeSsOutput(F.LINUX_SS_LTNP)).toBe(true);
    expect(looksLikeSsOutput(F.LINUX_SS_LTNP_NETID)).toBe(true);
    expect(looksLikeNetstatOutput(F.MACOS_NETSTAT_TCP)).toBe(true);
    expect(looksLikeNetstatOutput(F.LINUX_NETSTAT_LTNP)).toBe(true);
    expect(looksLikeWindowsNetstatOutput(F.WINDOWS_NETSTAT_ANO)).toBe(true);
    // The German capture: the banner and the column names are translated,
    // and `Proto` is the one token Windows leaves alone.
    expect(looksLikeWindowsNetstatOutput(F.WINDOWS_NETSTAT_ANO_LOCALIZED)).toBe(true);
    // Header-only, which is the captured container's real /proc/net/tcp.
    expect(looksLikeProcNetTcp(F.LINUX_PROC_NET_TCP_EMPTY)).toBe(true);
    expect(looksLikeProcNetTcp(F.LINUX_PROC_NET_TCP6)).toBe(true);
  });

  test("silence, and somebody else's output, are not recognised", () => {
    // This is the distinction the recognisers exist for: zero rows from a
    // command that really answered means nothing is listening, and zero
    // rows from output like this means nothing was learned at all.
    for (const recognise of [
      looksLikeSsOutput,
      looksLikeNetstatOutput,
      looksLikeWindowsNetstatOutput,
      looksLikeProcNetTcp,
    ]) {
      expect(recognise("")).toBe(false);
      expect(recognise("Cannot open netlink socket: Permission denied\n")).toBe(false);
      expect(recognise(F.LINUX_IP_J_UNSUPPORTED)).toBe(false);
    }
  });
});

describe("hex addresses in /proc/net", () => {
  test("IPv4 is host byte order — reading it the other way gives 1.0.0.127", () => {
    expect(hexToIpv4("0100007F")).toBe("127.0.0.1");
    expect(hexToIpv4("00000000")).toBe("0.0.0.0");
    expect(hexToIpv4("nonsense")).toBeNull();
  });

  test("IPv6 is four little-endian words, compressed per RFC 5952", () => {
    expect(hexToIpv6("00000000000000000000000000000000")).toBe("::");
    expect(hexToIpv6("00000000000000000000000001000000")).toBe("::1");
    expect(hexToIpv6("0000000000000000FFFF00000100007F")).toBe("::ffff:127.0.0.1");
  });

  test("the longest zero run is the one compressed", () => {
    // 2001:db8:0:1:0:0:0:1
    expect(formatIpv6([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1])).toBe(
      "2001:db8:0:1::1",
    );
  });
});

describe("macOS netstat", () => {
  const sockets = parseBsdNetstat(F.MACOS_NETSTAT_TCP);

  test("only LISTEN rows are listeners", () => {
    expect(sockets.every((s) => s.port > 0)).toBe(true);
    // The capture also holds ESTABLISHED, LAST_ACK and CLOSE_WAIT rows.
    expect(sockets.some((s) => s.port === 50861)).toBe(false);
    expect(sockets.length).toBe(17);
  });

  test("tcp46 is a dual-stack socket, not a v4 one", () => {
    expect(sockets.find((s) => s.port === 8770)).toMatchObject({ family: "dual", address: "*" });
    expect(sockets.find((s) => s.port === 631 && s.address === "::1")).toMatchObject({
      family: "ipv6",
    });
  });

  test("it sees sockets an unprivileged lsof cannot", () => {
    // This is the pairing the tool is built on: the same machine, seconds
    // apart. netstat has root's listeners; lsof as an ordinary user does not.
    const lsof = parseLsofFields(F.MACOS_LSOF_FIELDS);
    expect(sockets.some((s) => s.port === 631)).toBe(true);
    expect(sockets.some((s) => s.port === 22)).toBe(true);
    expect(lsof.some((r) => r.port === 631)).toBe(false);
    expect(lsof.some((r) => r.port === 22)).toBe(false);
  });
});

describe("lsof", () => {
  test("the field form keeps the full process name", () => {
    const records = parseLsofFields(F.MACOS_LSOF_FIELDS);
    expect(records.find((r) => r.port === 49153)?.process).toBe("com.docker.backend");
    expect(records.find((r) => r.port === 11434)).toMatchObject({
      pid: 805,
      process: "ollama",
      user: "agent",
      uid: 501,
      address: "127.0.0.1",
    });
  });

  test("the process fields carry across every descriptor under one process", () => {
    // rapportd holds the same socket on two descriptors; both rows must keep
    // its name, pid and user, which only appear on the `p` block header.
    const records = parseLsofFields(F.MACOS_LSOF_FIELDS).filter((r) => r.port === 55230);
    expect(records.length).toBe(2);
    expect(records.every((r) => r.process === "rapportd" && r.pid === 760)).toBe(true);
  });

  test("the column form truncates the name, which is why it is second", () => {
    const records = parseLsofColumns(F.MACOS_LSOF_COLUMNS);
    expect(records.find((r) => r.pid === 877)?.process).toBe("com.docke");
    expect(parseLsofFields(F.MACOS_LSOF_FIELDS).find((r) => r.pid === 877)?.process).toBe(
      "com.docker.backend",
    );
  });

  test("an escaped space in a command name is decoded", () => {
    expect(decodeLsofName("Photo\\x20A")).toBe("Photo A");
    expect(parseLsofColumns(F.MACOS_LSOF_COLUMNS).find((r) => r.pid === 1248)?.process).toBe(
      "Photo A",
    );
  });

  test("the column form reads a bracketed IPv6 address", () => {
    expect(parseLsofColumns(F.MACOS_LSOF_COLUMNS).find((r) => r.pid === 1248)).toMatchObject({
      address: "::1",
      port: 15292,
    });
  });
});

describe("ss", () => {
  const sockets = parseSsListen(F.LINUX_SS_LTNP);

  test("a socket with no Process column is kept, with an unknown owner", () => {
    const cups = sockets.find((s) => s.port === 631);
    expect(cups).toMatchObject({ address: "127.0.0.1", ownerKnown: false });
    expect(cups?.owners).toEqual([]);
  });

  test("two processes on one socket are both reported", () => {
    expect(
      parseSsUsers('users:(("nginx",pid=1200,fd=6),("nginx",pid=1201,fd=6))').map((o) => o.pid),
    ).toEqual([1200, 1201]);
    expect(sockets.find((s) => s.port === 80)?.owners.length).toBe(2);
  });

  test("an interface-scoped address keeps its address and loses its zone", () => {
    expect(sockets.find((s) => s.port === 53)).toMatchObject({
      address: "127.0.0.53",
      family: "ipv4",
    });
  });

  test("a build that prints the Netid column parses the same", () => {
    expect(parseSsListen(F.LINUX_SS_LTNP_NETID)).toEqual([
      {
        address: "*",
        port: 3000,
        // `0.0.0.0:3000` in that fixture: a v4 wildcard, which is not the
        // same claim as the bare `*` a dual-stack bind prints.
        family: "ipv4",
        owners: [{ pid: 9182, process: "node", user: null, uid: null }],
        ownerKnown: true,
      },
    ]);
  });

  test("the header row is not a socket", () => {
    expect(sockets.length).toBe(5);
  });
});

describe("Linux netstat", () => {
  test("`:::9090` is a port, not a parse failure", () => {
    const sockets = parseLinuxNetstat(F.LINUX_NETSTAT_LTNP);
    expect(sockets.map((s) => s.port).sort((a, b) => a - b)).toEqual([8080, 9090]);
    expect(sockets[0]).toMatchObject({ address: "*", family: "ipv6", ownerKnown: true });
    expect(sockets[0]?.owners[0]).toMatchObject({ pid: 11, process: "nc" });
  });

  test("a `-` in the PID column is an unknown owner, not an unowned socket", () => {
    const sockets = parseLinuxNetstat(F.LINUX_NETSTAT_LTNP_UNPRIVILEGED);
    expect(sockets.length).toBe(4);
    const ssh = sockets.find((s) => s.port === 22 && s.family === "ipv4");
    expect(ssh).toMatchObject({ ownerKnown: false });
    expect(ssh?.owners).toEqual([]);
    expect(sockets.find((s) => s.port === 8080)?.owners[0]).toMatchObject({
      pid: 4821,
      process: "node",
    });
  });
});

describe("Windows netstat", () => {
  test("listeners are found without matching the localized state word", () => {
    const sockets = parseWindowsNetstat(F.WINDOWS_NETSTAT_ANO);
    expect(sockets.map((s) => s.port).sort((a, b) => a - b)).toEqual([135, 135, 139, 445, 5939]);
    // The ESTABLISHED row is not a listener.
    expect(sockets.some((s) => s.port === 51234)).toBe(false);
  });

  test("a German Windows reports its listeners too", () => {
    // `ABHÖREN` is what that machine prints instead of LISTENING. Matching
    // the English word would report this host as having nothing listening.
    const sockets = parseWindowsNetstat(F.WINDOWS_NETSTAT_ANO_LOCALIZED);
    expect(sockets.map((s) => s.port).sort((a, b) => a - b)).toEqual([135, 3000]);
    expect(sockets.find((s) => s.port === 3000)?.owners[0]?.pid).toBe(7412);
  });

  test("UDP rows have one column fewer and are not read as TCP listeners", () => {
    const sockets = parseWindowsNetstat(F.WINDOWS_NETSTAT_ANO);
    expect(sockets.some((s) => s.port === 5353)).toBe(false);
    expect(sockets.some((s) => s.port === 3702)).toBe(false);
  });

  test("a pid alone is not a known owner", () => {
    expect(parseWindowsNetstat(F.WINDOWS_NETSTAT_ANO)[0]?.ownerKnown).toBe(false);
  });

  test("tasklist's quoted CSV survives the comma inside the memory column", () => {
    const names = parseTasklistCsv(F.WINDOWS_TASKLIST_CSV);
    expect(names.get(968)).toBe("svchost.exe");
    expect(names.get(7412)).toBe("node.exe");
    expect(names.size).toBe(5);
  });
});

describe("/proc/net/tcp", () => {
  test("one file alone answers 'nothing is listening' with two servers running", () => {
    // Captured together: tcp is header-only while tcp6 holds both listeners,
    // because busybox `nc` binds dual-stack.
    expect(parseProcNetTcp(F.LINUX_PROC_NET_TCP_EMPTY, "ipv4")).toEqual([]);
    expect(
      parseProcNetTcp(F.LINUX_PROC_NET_TCP6, "ipv6")
        .map((s) => s.port)
        .sort((a, b) => a - b),
    ).toEqual([8080, 9090]);
  });

  test("only state 0A is a listener, and the uid comes with it", () => {
    const sockets = parseProcNetTcp(F.LINUX_PROC_NET_TCP, "ipv4");
    expect(sockets.length).toBe(2); // the third row is ESTABLISHED
    expect(sockets[0]).toMatchObject({ address: "127.0.0.1", port: 8080, ownerKnown: false });
    expect(sockets[0]?.owners[0]).toMatchObject({ uid: 1000, pid: null, process: null });
    expect(sockets[1]).toMatchObject({ address: "*", port: 22 });
    expect(sockets[1]?.owners[0]?.uid).toBe(0);
  });
});

describe("joining owners onto sockets", () => {
  test("a socket with no owner is kept, not dropped", () => {
    const sockets = dedupeSockets(parseBsdNetstat(F.MACOS_NETSTAT_TCP));
    const joined = joinOwners(sockets, parseLsofFields(F.MACOS_LSOF_FIELDS));
    const cups = joined.find((s) => s.port === 631);
    expect(cups).toBeDefined();
    expect(cups?.ownerKnown).toBe(false);
    // …while the ones lsof could see do have names.
    expect(joined.find((s) => s.port === 11434)?.owners[0]?.process).toBe("ollama");
  });

  test("the join ignores the family, because the two sources disagree about it", () => {
    // netstat calls port 8770 `tcp46`; lsof calls the same socket IPv6.
    const joined = joinOwners(
      dedupeSockets(parseBsdNetstat(F.MACOS_NETSTAT_TCP)),
      parseLsofFields(F.MACOS_LSOF_FIELDS),
    );
    expect(joined.find((s) => s.port === 8770)).toMatchObject({ family: "dual", ownerKnown: true });
  });

  test("one process holding a socket on two descriptors is reported once", () => {
    const joined = joinOwners(
      [{ address: "*", port: 55230, family: "dual", owners: [], ownerKnown: false }],
      parseLsofFields(F.MACOS_LSOF_FIELDS),
    );
    expect(joined[0]?.owners.length).toBe(1);
    expect(joined[0]?.owners[0]).toMatchObject({ pid: 760, process: "rapportd" });
  });

  test("two different processes sharing a socket are both kept", () => {
    const joined = joinOwners(
      [{ address: "127.0.0.1", port: 49153, family: "ipv4", owners: [], ownerKnown: false }],
      parseLsofColumns(F.MACOS_LSOF_COLUMNS),
    );
    expect(joined[0]?.owners.map((o) => o.pid)).toEqual([877, 916]);
  });
});

describe("ordering", () => {
  test("sockets come back in a stable order regardless of input order", () => {
    const a = sortSockets(parseBsdNetstat(F.MACOS_NETSTAT_TCP));
    const b = sortSockets([...parseBsdNetstat(F.MACOS_NETSTAT_TCP)].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.map((s) => s.port)).toEqual([...a.map((s) => s.port)].sort((x, y) => x - y));
  });

  test("dedupe keeps the row that knows the owner", () => {
    const deduped = dedupeSockets([
      { address: "*", port: 80, family: "ipv4", owners: [], ownerKnown: false },
      {
        address: "*",
        port: 80,
        family: "ipv4",
        owners: [{ pid: 1, process: "nginx", user: null, uid: null }],
        ownerKnown: true,
      },
    ]);
    expect(deduped.length).toBe(1);
    expect(deduped[0]?.ownerKnown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the unknown vocabulary
// ---------------------------------------------------------------------------

describe("unknowns", () => {
  test("the first reason for a field wins, and the list is sorted", () => {
    const unknowns = new Unknowns();
    unknowns.add("cpu.model", "/proc/cpuinfo", "specific");
    unknowns.add("cpu.model", "everything", "generic");
    unknowns.add("battery.percent", "pmset", "no line");
    expect(unknowns.list().map((u) => u.field)).toEqual(["battery.percent", "cpu.model"]);
    expect(unknowns.list()[1]?.reason).toBe("specific");
  });

  test("a missing command is told apart from a command that refused", () => {
    expect(failureReason("not-installed", "").reason).toContain("not installed");
    expect(failureReason("timed-out", "").reason).toContain("timeout");
    expect(failureReason("exit-nonzero", "ss: permission denied").reason).toContain(
      "permission denied",
    );
  });

  test("a twenty-line usage message is cut down to one", () => {
    const line = firstLine(F.LINUX_IP_J_UNSUPPORTED);
    expect(line).toContain("BusyBox");
    expect(line).not.toContain("\n");
    expect(firstLine("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });
});
