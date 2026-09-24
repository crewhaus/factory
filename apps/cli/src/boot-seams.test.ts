/**
 * Every boot seam in a tool package has a delivery path.
 *
 * A boot seam is how a tool package learns what the operator configured: a
 * public function that replaces a process-wide binding (`registerHttpConfig`,
 * `setChainRpcResolver`, `setPeerPolicy`). 0.7.0 shipped nineteen of them and
 * nothing called most of them, so sixty-odd tools refused every call however
 * the spec was written. The scope here is READ FROM THE CODE, never listed.
 * In every `packages/tool-*` package, a function is a seam when either
 *
 *   - its source (`export function`, no leading underscore — those are test
 *     seams) assigns a module-level `let` of its own file; or
 *   - the package's entry exports it under a seam's name: `register…`,
 *     `set…` or `bind…` followed by a capital (`registerHttpConfig`,
 *     `setChainRpcResolver`, `bindEvmChains`, `registerChannelAdapter`).
 *
 * Each one must be delivered by the builtin table in
 * `@crewhaus/tool-categories`:
 *
 *   - it IS a boot registrar (`TOOL_BOOT_REGISTRARS`), which every emitter,
 *     `crewhaus run` and `crewhaus eval` call; or
 *   - a registrar of its package BINDS it — and the registrar's source is read
 *     to prove it calls the seam; or
 *   - a host binds it (`HOST_BOOT_SEAMS`) — and the named caller files are
 *     read to prove they call it; or
 *   - it is optional on purpose (`OPTIONAL_BOOT_SEAMS`), with the reason.
 *
 * The tables are checked the other way too, so a row cannot outlive its seam.
 * The check itself is a pure function, and the last test feeds it broken
 * tables and a new unbound seam to prove it fails on each.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_TOOLS,
  HOST_BOOT_SEAMS,
  OPTIONAL_BOOT_SEAMS,
  TOOL_BOOT_REGISTRARS,
} from "@crewhaus/tool-categories";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PACKAGES = join(ROOT, "packages");

type Seam = {
  readonly pkg: string;
  readonly symbol: string;
  readonly file: string;
  /** How the scan found it: what its code does, what its name says, or both. */
  readonly by?: "code" | "name" | "both";
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** `export function name(` … the closing brace at column 0. */
function functionBody(text: string, name: string): string | undefined {
  const start = text.search(new RegExp(`^export (?:async )?function ${name}\\s*[(<]`, "m"));
  if (start === -1) return undefined;
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end === -1 ? undefined : end);
}

function toolPackages(): string[] {
  return readdirSync(PACKAGES)
    .filter((d) => d.startsWith("tool-"))
    .filter((d) => {
      try {
        return statSync(join(PACKAGES, d, "src")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Where `symbol` is defined in a package, for messages; the entry when no file says. */
function definingFile(dir: string, symbol: string): string {
  for (const file of sourceFiles(join(PACKAGES, dir, "src"))) {
    if (functionBody(readFileSync(file, "utf8"), symbol) !== undefined) return file;
  }
  return join(PACKAGES, dir, "src", "index.ts");
}

/** A name a boot seam goes by: `register…`, `set…` or `bind…`, then a capital. */
const SEAM_NAME_RE = /^(?:register|set|bind)[A-Z]\w*$/;

/**
 * Every boot seam in the tool packages: what the code does (assigns a
 * module-level `let`), and what the package entry exports under a seam's
 * name. One entry per package and symbol.
 */
async function scanSeams(): Promise<Seam[]> {
  const seams = new Map<string, Seam>();
  const add = (seam: Seam): void => {
    const id = `${seam.pkg}#${seam.symbol}`;
    const earlier = seams.get(id);
    seams.set(id, earlier === undefined ? seam : { ...earlier, by: "both" });
  };
  for (const dir of toolPackages()) {
    const pkg = `@crewhaus/${dir}`;
    for (const file of sourceFiles(join(PACKAGES, dir, "src"))) {
      const text = readFileSync(file, "utf8");
      const lets = [...text.matchAll(/^let (\w+)/gm)].map((m) => m[1] as string);
      if (lets.length === 0) continue;
      for (const m of text.matchAll(/^export (?:async )?function (\w+)\s*[(<]/gm)) {
        const symbol = m[1] as string;
        if (symbol.startsWith("_")) continue;
        const body = (functionBody(text, symbol) ?? "").split("\n").slice(1).join("\n");
        const assigns = lets.some((l) => new RegExp(`(^|[^.\\w])${l}\\s*=(?!=)`, "m").test(body));
        if (assigns) add({ pkg, symbol, file, by: "code" });
      }
    }
    const entry = join(PACKAGES, dir, "src", "index.ts");
    if (!existsSync(entry)) continue;
    const mod = (await import(entry)) as Record<string, unknown>;
    for (const [symbol, value] of Object.entries(mod)) {
      if (typeof value !== "function" || !SEAM_NAME_RE.test(symbol)) continue;
      add({ pkg, symbol, file: definingFile(dir, symbol), by: "name" });
    }
  }
  return [...seams.values()].sort((a, b) =>
    `${a.pkg}#${a.symbol}` < `${b.pkg}#${b.symbol}` ? -1 : 1,
  );
}

type Tables = {
  readonly registrars: typeof TOOL_BOOT_REGISTRARS;
  readonly hosts: typeof HOST_BOOT_SEAMS;
  readonly optional: typeof OPTIONAL_BOOT_SEAMS;
};

/** The source of a package's exported function, searched across the package. */
function packageFunction(pkg: string, symbol: string): string | undefined {
  const dir = join(PACKAGES, pkg.replace("@crewhaus/", ""), "src");
  for (const file of sourceFiles(dir)) {
    const body = functionBody(readFileSync(file, "utf8"), symbol);
    if (body !== undefined) return body;
  }
  return undefined;
}

/** Everything wrong with the delivery of `seams` under `tables`. Empty is the goal. */
function deliveryProblems(seams: ReadonlyArray<Seam>, tables: Tables): string[] {
  const problems: string[] = [];
  const found = new Set(seams.map((s) => `${s.pkg}#${s.symbol}`));
  for (const seam of seams) {
    const reg = tables.registrars[seam.symbol];
    const bound = Object.values(tables.registrars).some(
      (r) => r.package === seam.pkg && (r.binds ?? []).includes(seam.symbol),
    );
    const host = tables.hosts[seam.symbol];
    const optional = tables.optional[seam.symbol];
    const ok =
      (reg !== undefined && reg.package === seam.pkg) ||
      bound ||
      (host !== undefined && host.package === seam.pkg) ||
      (optional !== undefined && optional.package === seam.pkg);
    if (!ok) {
      problems.push(
        `${seam.pkg} ${seam.symbol} (${seam.file.slice(ROOT.length + 1)}) has no delivery path: make it a registrar in TOOL_BOOT_REGISTRARS, bind it from one, or add it to HOST_BOOT_SEAMS / OPTIONAL_BOOT_SEAMS`,
      );
    }
  }
  for (const [symbol, reg] of Object.entries(tables.registrars)) {
    const body = packageFunction(reg.package, symbol);
    if (body === undefined) {
      problems.push(`${reg.package} does not export the registrar ${symbol}`);
      continue;
    }
    for (const bind of reg.binds ?? []) {
      if (!new RegExp(`\\b${bind}\\(`).test(body)) {
        problems.push(`${symbol} is said to bind ${bind}, but its source never calls it`);
      }
      if (!bind.startsWith("_") && !found.has(`${reg.package}#${bind}`)) {
        problems.push(`${symbol} binds ${bind}, which is not a boot seam of ${reg.package}`);
      }
    }
  }
  for (const [symbol, host] of Object.entries(tables.hosts)) {
    if (!found.has(`${host.package}#${symbol}`))
      problems.push(`HOST_BOOT_SEAMS ${symbol} is not a boot seam`);
    for (const caller of host.callers) {
      const text = readFileSync(join(ROOT, caller), "utf8");
      if (!new RegExp(`\\b${symbol}\\(`).test(text)) {
        problems.push(`HOST_BOOT_SEAMS says ${caller} binds ${symbol}, and it does not`);
      }
    }
  }
  for (const [symbol, opt] of Object.entries(tables.optional)) {
    if (!found.has(`${opt.package}#${symbol}`))
      problems.push(`OPTIONAL_BOOT_SEAMS ${symbol} is not a boot seam`);
  }
  return problems;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

const REAL: Tables = {
  registrars: TOOL_BOOT_REGISTRARS,
  hosts: HOST_BOOT_SEAMS,
  optional: OPTIONAL_BOOT_SEAMS,
};

describe("every boot seam in a tool package has a delivery path", () => {
  let seams: Seam[] = [];
  // Imports every tool package's entry, which takes a few seconds on a CI runner.
  beforeAll(async () => {
    seams = await scanSeams();
  }, 60_000);

  test("the scan finds the seams it is meant to guard", () => {
    // A guard that matches nothing passes vacuously, so the count is pinned:
    // raise it when a seam is added (and deliver the seam), lower it when one
    // is removed.
    // Each half of the scan is pinned on its own, so neither can go quiet.
    const by = (how: "code" | "name") =>
      seams.filter((s) => s.by === how || s.by === "both").map((s) => s.symbol);
    expect(seams.length).toBe(35);
    expect(by("code").length).toBe(21);
    expect(by("name").length).toBe(34);
    expect(by("code")).toContain("setChainRpcResolver");
    expect(by("name")).toContain("registerChannelAdapter");
    expect(by("name")).toContain("bindEvmChains");
  });

  test("each one is a registrar, bound by one, bound by a host, or optional on purpose", () => {
    expect(deliveryProblems(seams, REAL)).toEqual([]);
  });

  test("every tool_config registrar is named by a builtin row, so emitters call it", () => {
    for (const [symbol, reg] of Object.entries(TOOL_BOOT_REGISTRARS)) {
      const rows = Object.values(BUILTIN_TOOLS).filter(
        (e) => e.initSymbol === symbol || e.chainSymbol === symbol,
      );
      expect({ symbol, rows: rows.length > 0 }).toEqual({ symbol, rows: true });
      expect(reg.source === "tool_config" ? (reg.keys ?? []).length > 0 : true).toBe(true);
    }
  });

  test("the check fails when a delivery is taken away, or a new seam arrives unbound", () => {
    const withoutHttp = Object.fromEntries(
      Object.entries(TOOL_BOOT_REGISTRARS).filter(([s]) => s !== "registerHttpConfig"),
    );
    expect(deliveryProblems(seams, { ...REAL, registrars: withoutHttp }).join("\n")).toContain(
      "@crewhaus/tool-http registerHttpConfig",
    );

    const chainreadUnbinds = {
      ...TOOL_BOOT_REGISTRARS,
      registerChainreadConfig: {
        ...must(TOOL_BOOT_REGISTRARS["registerChainreadConfig"], "registerChainreadConfig"),
        binds: [],
      },
    };
    expect(deliveryProblems(seams, { ...REAL, registrars: chainreadUnbinds }).join("\n")).toContain(
      "@crewhaus/tool-chainread setRpcEndpointPolicy",
    );

    const wrongBind = {
      ...TOOL_BOOT_REGISTRARS,
      registerObsConfig: {
        ...must(TOOL_BOOT_REGISTRARS["registerObsConfig"], "registerObsConfig"),
        binds: ["setPeerPolicy"],
      },
    };
    expect(deliveryProblems(seams, { ...REAL, registrars: wrongBind }).join("\n")).toContain(
      "registerObsConfig is said to bind setPeerPolicy, but its source never calls it",
    );

    const newSeam: Seam = {
      pkg: "@crewhaus/tool-http",
      symbol: "setHttpTransport",
      file: join(PACKAGES, "tool-http", "src", "net.ts"),
    };
    expect(deliveryProblems([...seams, newSeam], REAL).join("\n")).toContain(
      "@crewhaus/tool-http setHttpTransport",
    );

    const withoutChannelHost = Object.fromEntries(
      Object.entries(HOST_BOOT_SEAMS).filter(([s]) => s !== "registerChannelAdapter"),
    );
    expect(deliveryProblems(seams, { ...REAL, hosts: withoutChannelHost }).join("\n")).toContain(
      "@crewhaus/tool-message-channel registerChannelAdapter",
    );

    const staleHost = {
      ...HOST_BOOT_SEAMS,
      registerRetrieveConfig: {
        ...must(HOST_BOOT_SEAMS["registerRetrieveConfig"], "registerRetrieveConfig"),
        callers: ["packages/tool-http/src/net.ts"],
      },
    };
    expect(deliveryProblems(seams, { ...REAL, hosts: staleHost }).join("\n")).toContain(
      "HOST_BOOT_SEAMS says packages/tool-http/src/net.ts binds registerRetrieveConfig, and it does not",
    );
  });
});
