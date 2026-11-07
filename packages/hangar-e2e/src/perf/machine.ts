/**
 * What machine a benchmark ran on. A number means little without this. Neither
 * command exists everywhere, and a host without them says so: the fingerprint
 * holds "unknown", never a guess.
 */

export const UNKNOWN = "unknown";

export type MachineFingerprint = {
  readonly cpu: string;
  readonly cores: string;
  readonly memoryBytes: string;
  readonly model: string;
  readonly os: string;
  readonly osVersion: string;
};

/** `key: value` lines, with any amount of space after the colon. */
function keyValues(text: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return out;
}

const known = (value: string | undefined): string =>
  value === undefined || value === "" ? UNKNOWN : value;

/** Read recorded `sysctl` and `sw_vers` output. Missing output reads as unknown. */
export function parseMachine(
  sysctl: string | undefined,
  swVers: string | undefined,
): MachineFingerprint {
  const hardware = keyValues(sysctl);
  const system = keyValues(swVers);
  return {
    cpu: known(hardware.get("machdep.cpu.brand_string")),
    cores: known(hardware.get("hw.ncpu")),
    memoryBytes: known(hardware.get("hw.memsize")),
    model: known(hardware.get("hw.model")),
    os: known(system.get("ProductName")),
    osVersion: known(system.get("ProductVersion")),
  };
}

function output(argv: readonly string[]): string | undefined {
  try {
    const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** This machine's fingerprint. */
export function machineFingerprint(): MachineFingerprint {
  return parseMachine(
    output(["sysctl", "machdep.cpu.brand_string", "hw.ncpu", "hw.memsize", "hw.model"]),
    output(["sw_vers"]),
  );
}
