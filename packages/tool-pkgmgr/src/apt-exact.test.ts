/**
 * C021 — an apt "install" can never uninstall, and a name apt reads as a
 * pattern is never answered or installed as if it were a package.
 *
 * Verified against apt 2.6.1 in an offline debian:12-slim container before
 * these tests were written: `apt-get install -y -- tzdata-` REMOVED tzdata
 * (exit 0), so did `tzdata=2026b-0+deb12u1-`; `apt-cache policy -- 'lib.+'`
 * printed 116 stanzas, and the old parser reported the LAST one's candidate
 * as "lib.+"'s; `tzdata=<version>+` installed <version>. With
 * `-o APT::Cmd::Pattern-Only=true`, `lib.+` locates nothing, exact names
 * (`tzdata`, `libc6:<native arch>`) still resolve; `--no-remove` aborts
 * (exit 100) any transaction that would remove a package.
 *
 * The runner seam serves recorded output by the command it was asked for,
 * and records every argv, so the assertions are about what reached a
 * command line.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  APT_INSTALL_HTOP,
  APT_POLICY_CURL,
  APT_POLICY_HTOP,
  APT_SIMULATE_CURL_UPGRADE,
  APT_SIMULATE_HTOP,
  DPKG_NO_SUCH_PACKAGE,
  DPKG_QUERY_CURL,
  DPKG_QUERY_HTOP_AFTER,
} from "./fixtures";
import { _resetHostSeams, _setPlatform, _setUid } from "./host";
import { packageInstall, packageQuery } from "./index";
import { PKGMGR_COMMANDS } from "./lib/managers";
import { _setRunner } from "./run";

/** Two stanzas: what apt prints when it read the operand as a pattern. */
const POLICY_TWO_STANZAS = `libfoo:
  Installed: (none)
  Candidate: 1.0-1
  Version table:
     1.0-1 500
        500 http://deb.debian.org/debian bookworm/main amd64 Packages
libbar:
  Installed: (none)
  Candidate: 2.0-1
  Version table:
     2.0-1 500
        500 http://deb.debian.org/debian bookworm/main amd64 Packages
`;

const POLICY_TZDATA = `tzdata:
  Installed: 2026b-0+deb12u1
  Candidate: 2026b-0+deb12u1
  Version table:
 *** 2026b-0+deb12u1 100
        100 /var/lib/dpkg/status
`;

type Answer = { code?: number; stdout?: string; stderr?: string };
type Script = {
  dpkg?: Answer | Answer[];
  policy?: Answer;
  simulate?: Answer;
  install?: Answer;
};

let argvs: string[][] = [];

function serve(script: Script): void {
  let dpkgCalls = 0;
  _setRunner(async (request: { readonly argv: readonly string[] }) => {
    const argv = [...request.argv];
    argvs.push(argv);
    const [cmd, sub] = argv;
    let answer: Answer = {};
    if (argv.includes("--version")) answer = { stdout: `${cmd} 1.0\n` };
    else if (cmd === "dpkg-query") {
      const d = script.dpkg;
      answer = Array.isArray(d) ? (d[Math.min(dpkgCalls++, d.length - 1)] ?? {}) : (d ?? {});
    } else if (cmd === "apt-cache" && sub === "policy") answer = script.policy ?? {};
    else if (cmd === "apt-get" && argv.includes("-s")) answer = script.simulate ?? {};
    else if (cmd === "apt-get" && sub === "install") answer = script.install ?? {};
    else throw new Error(`unscripted command: ${argv.join(" ")}`);
    return {
      code: answer.code ?? 0,
      stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "",
      timedOut: false,
      missing: false,
    } as never;
  });
}

const realInstalls = () =>
  argvs.filter((a) => a[0] === "apt-get" && a[1] === "install" && !a.includes("-s"));
const simulations = () => argvs.filter((a) => a[0] === "apt-get" && a.includes("-s"));

async function call(tool: typeof packageInstall, input: Record<string, unknown>) {
  return JSON.parse(String(await tool.execute({ manager: "apt", ...input }))) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  argvs = [];
  _setPlatform("linux");
  _setUid(0); // root: every apt refusal below is NOT the privilege gate
});

afterEach(() => {
  _resetHostSeams();
  _setRunner(undefined);
});

describe("a trailing '-' never reaches apt as an install operand", () => {
  test("in the name, the architecture, or the version — refused before anything is spawned", async () => {
    serve({
      dpkg: { stdout: "tzdata\t2026b-0+deb12u1\tii \n" },
      policy: { stdout: POLICY_TZDATA },
    });
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { name: "tzdata-" },
      { name: "tzdata:all-" },
      { name: "tzdata", version: "2026b-0+deb12u1-" },
      { name: "tzdata-", dryRun: true },
    ];
    for (const input of cases) {
      argvs = [];
      const out = await call(packageInstall, input);
      const label = JSON.stringify(input);
      expect({ label, status: out["status"] }).toEqual({ label, status: "refused" });
      expect({ label, why: String(out["reason"]).includes("remove") }).toEqual({
        label,
        why: true,
      });
      // Only the manager probe ran; no argv carries the operand.
      expect({ label, spawned: argvs.filter((a) => !a.includes("--version")) }).toEqual({
        label,
        spawned: [],
      });
    }
  });
});

describe("a name apt reads as a pattern is not a package", () => {
  test("PackageQuery says unknown, never another package's version", async () => {
    serve({
      dpkg: { code: 1, stderr: "dpkg-query: no packages found matching lib.+\n" },
      policy: { stdout: POLICY_TWO_STANZAS },
    });
    const out = await call(packageQuery, { name: "lib.+" });
    expect(out["status"]).toBe("unknown");
    expect(out["available"]).toBeNull();
    expect(out["knownToManager"]).toBeNull();
    const unknown = JSON.stringify(out["unknown"]);
    expect(unknown).toContain("pattern");
    expect(unknown).toContain("libfoo, libbar");
    // The version of libbar (the old parser's last-stanza answer) is nowhere.
    expect(JSON.stringify(out)).not.toContain('"2.0-1"');
  });

  test("PackageInstall refuses it, simulates nothing and installs nothing", async () => {
    serve({
      dpkg: { code: 1, stderr: "dpkg-query: no packages found matching lib.+\n" },
      policy: { stdout: POLICY_TWO_STANZAS },
    });
    for (const dryRun of [false, true]) {
      argvs = [];
      const out = await call(packageInstall, { name: "lib.+", dryRun });
      expect({ dryRun, status: out["status"] }).toEqual({ dryRun, status: "refused" });
      expect(String(out["reason"])).toContain("exactly");
      expect({ dryRun, sim: simulations(), real: realInstalls() }).toEqual({
        dryRun,
        sim: [],
        real: [],
      });
    }
  });

  test("a name apt does not know at all is refused with that reason", async () => {
    serve({ dpkg: { code: 1, stderr: DPKG_NO_SUCH_PACKAGE }, policy: { stdout: "" } });
    const out = await call(packageInstall, { name: "nosuchpkg" });
    expect(out["status"]).toBe("refused");
    expect(String(out["reason"])).toContain("no package named exactly");
    expect(simulations()).toEqual([]);
  });

  test("a version apt does not list is refused, so a trailing '+' cannot install a different one", async () => {
    serve({
      dpkg: { stdout: "tzdata\t2026b-0+deb12u1\tii \n" },
      policy: { stdout: POLICY_TZDATA },
    });
    const out = await call(packageInstall, { name: "tzdata", version: "2026b-0+deb12u1+" });
    expect(out["status"]).toBe("refused");
    expect(String(out["reason"])).toContain("no version");
    expect(String(out["reason"])).toContain("2026b-0+deb12u1");
    expect(simulations()).toEqual([]);
    expect(realInstalls()).toEqual([]);
  });

  test("g++ and a native-architecture name are still exact names", async () => {
    // Over-tightening guard: a name that ENDS in '+' is legal, and apt prints
    // a native-arch operand's stanza under the bare name.
    serve({
      dpkg: { code: 1, stderr: "dpkg-query: no packages found matching g++\n" },
      policy: {
        stdout:
          "g++:\n  Installed: (none)\n  Candidate: 4:12.2.0-3\n  Version table:\n     4:12.2.0-3 500\n",
      },
      simulate: { stdout: "Inst g++ (4:12.2.0-3 Debian:12.5/stable [amd64])\n" },
    });
    const gpp = await call(packageInstall, { name: "g++", dryRun: true });
    expect(gpp["status"]).toBe("would-install");
    serve({
      dpkg: { stdout: "libc6:amd64\t2.36-9+deb12u14\tii \n" },
      policy: {
        stdout:
          "libc6:\n  Installed: 2.36-9+deb12u14\n  Candidate: 2.36-9+deb12u14\n  Version table:\n *** 2.36-9+deb12u14 100\n",
      },
      simulate: { stdout: "" },
    });
    const libc = await call(packageInstall, { name: "libc6:amd64", dryRun: true });
    expect(libc["status"]).not.toBe("refused");
  });
});

describe("an install never removes", () => {
  test("a plan whose simulation removes a package is refused, dry run and real", async () => {
    serve({
      dpkg: { stdout: DPKG_QUERY_CURL },
      policy: { stdout: APT_POLICY_CURL },
      simulate: { stdout: APT_SIMULATE_CURL_UPGRADE },
    });
    const dry = await call(packageInstall, { name: "curl", dryRun: true });
    expect(dry["wouldBeRefused"]).toBe(true);
    expect(String(dry["wouldBeRefusedReason"])).toContain("REMOVES curl-legacy");
    argvs = [];
    const real = await call(packageInstall, { name: "curl", version: "7.88.1-10+deb12u7" });
    expect(real["status"]).toBe("refused");
    expect(String(real["reason"])).toContain("REMOVES curl-legacy");
    expect(simulations().length).toBe(1);
    expect(realInstalls()).toEqual([]);
  });

  test("the real install argv carries --no-remove and the pattern-only belt", async () => {
    serve({
      dpkg: [{ code: 1, stderr: DPKG_NO_SUCH_PACKAGE }, { stdout: DPKG_QUERY_HTOP_AFTER }],
      policy: { stdout: APT_POLICY_HTOP },
      simulate: { stdout: APT_SIMULATE_HTOP },
      install: { stdout: APT_INSTALL_HTOP },
    });
    const out = await call(packageInstall, { name: "htop" });
    expect(out["status"]).toBe("installed");
    expect(realInstalls()).toEqual([
      [
        "apt-get",
        "install",
        "-y",
        "--no-remove",
        "-o",
        "APT::Cmd::Pattern-Only=true",
        "--",
        "htop",
      ],
    ]);
    // Every apt command that takes a package operand carries the belt.
    const withOperand = argvs.filter(
      (a) => (a[0] === "apt-get" || a[0] === "apt-cache") && !a.includes("--version"),
    );
    // policy, simulate, install, and the policy re-read that verifies it
    expect(withOperand.map((a) => a.slice(0, 2).join(" "))).toEqual([
      "apt-cache policy",
      "apt-get install",
      "apt-get install",
      "apt-cache policy",
    ]);
    for (const argv of withOperand) expect(argv).toContain("APT::Cmd::Pattern-Only=true");
    expect(PKGMGR_COMMANDS.aptInstall).toContain("--no-remove");
  });
});

describe("descriptions fit every provider (C014)", () => {
  test("each tool's description is at most 1024 characters, OpenAI's function.description limit", () => {
    const tools = [packageQuery, packageInstall];
    expect(tools.length).toBe(2);
    const over = tools
      .filter((t) => [...t.description].length > 1024)
      .map((t) => `${t.name}(${t.description.length})`);
    expect(over).toEqual([]);
  });
});
