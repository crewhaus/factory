import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Both tools against a real temporary workspace.
 *
 * NO TEST HERE REACHES A NETWORK. `_setFetch` is installed in `beforeEach`
 * with a double that throws, so a code path that tried to would fail loudly
 * rather than quietly depend on api.osv.dev being up, on this machine having
 * egress, and on somebody else's rate limit.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCKFILE_NAMES } from "@crewhaus/tool-code";
import { _resetFetchConfig, _setDnsLookup, registerFetchConfig } from "@crewhaus/tool-fetch";
import { SUPPLYCHAIN_TOOLS, ciWorkflowAudit, dependencyAudit } from "./index";
import { _setFetch } from "./net";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context; these tools read only `signal`.
const ctx = {} as any;

async function raw(
  tool: (typeof SUPPLYCHAIN_TOOLS)[number],
  input: unknown,
  c = ctx,
): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return (await tool.execute(parsed.data, c)) as string;
}

async function call<T = Record<string, unknown>>(
  tool: (typeof SUPPLYCHAIN_TOOLS)[number],
  input: unknown,
  c = ctx,
): Promise<T> {
  return JSON.parse(await raw(tool, input, c)) as T;
}

// ---------------------------------------------------------------------------
// the OSV double

type Call = { url: string; method: string; body: unknown };

const SEVERITY_9_8 = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";

/**
 * A fake OSV.
 *
 * `matches` maps "name@version" to the advisory ids OSV would return, and
 * `records` maps an id to the record `/v1/vulns/{id}` would serve. Both are
 * deliberately separate so a test can make an id match with no record behind
 * it, which is a real OSV state and the one that must not read as clean.
 */
function mountOsv(spec: {
  matches?: Record<string, string[]>;
  records?: Record<string, unknown>;
  vulnStatus?: Record<string, number>;
}): Call[] {
  const calls: Call[] = [];
  _setFetch(async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method: init?.method ?? "GET", body });
    if (init?.signal?.aborted === true) throw new Error("aborted before send");
    if (url.endsWith("/v1/querybatch")) {
      const queries = (body as { queries: Array<{ package: { name: string }; version: string }> })
        .queries;
      return new Response(
        JSON.stringify({
          results: queries.map((q) => {
            const ids = spec.matches?.[`${q.package.name}@${q.version}`] ?? [];
            return ids.length === 0 ? {} : { vulns: ids.map((id) => ({ id })) };
          }),
        }),
        { status: 200 },
      );
    }
    const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const status = spec.vulnStatus?.[id] ?? 200;
    if (status !== 200) return new Response("nope", { status });
    const record = spec.records?.[id];
    if (record === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(record), { status: 200 });
  });
  return calls;
}

const lodashAdvisory = {
  id: "GHSA-lodash",
  aliases: ["CVE-2020-8203"],
  summary: "Prototype pollution in lodash",
  severity: [{ type: "CVSS_V3", score: SEVERITY_9_8 }],
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
      versions: ["4.17.15"],
    },
  ],
};

function writeBunLock(packages: Record<string, string>): void {
  writeFileSync(
    join(workspace, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [
          name,
          [`${name}@${version}`, "", {}, "sha512-AAAA=="],
        ]),
      ),
    }),
  );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-supplychain-"));
  process.chdir(workspace);
  // The default is a double that refuses: a test that forgets to mount one
  // must fail on this line, never by reaching out.
  _setFetch(async () => {
    throw new Error("a test reached the network");
  });
  _resetFetchConfig();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setFetch(undefined);
  _setDnsLookup(undefined);
  _resetFetchConfig();
});

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("both tools are exported, uniquely named and read-only", () => {
    expect(SUPPLYCHAIN_TOOLS.length).toBe(2);
    const names = SUPPLYCHAIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of SUPPLYCHAIN_TOOLS) {
      expect(tool.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: true,
      });
      expect({ name: tool.name, destructive: tool.destructive }).toEqual({
        name: tool.name,
        destructive: false,
      });
    }
  });

  test("only the tool that leaves the process is declared external", () => {
    // The compile-time scope audit binds `scope: external` to a declared
    // io-capability, so the two must agree per tool, not per package.
    expect({ scope: dependencyAudit.scope, io: dependencyAudit.ioCapability }).toEqual({
      scope: "external",
      io: "network",
    });
    expect({ scope: ciWorkflowAudit.scope, io: ciWorkflowAudit.ioCapability }).toEqual({
      scope: "internal",
      io: undefined,
    });
  });
});

describe("DependencyAudit — the answer", () => {
  test("a matched package reports its range, its fix and the limit of the claim", async () => {
    writeBunLock({ lodash: "4.17.15", "left-pad": "1.3.0" });
    const calls = mountOsv({
      matches: { "lodash@4.17.15": ["GHSA-lodash"] },
      records: { "GHSA-lodash": lodashAdvisory },
    });
    const result = await call(dependencyAudit, {});
    expect(result).toMatchObject({
      lockfiles: ["bun.lock"],
      packagesQueried: 2,
      batches: 1,
      matchCount: 1,
      packagesWithMatches: 1,
      distinctAdvisories: 1,
      noAdvisoriesMatched: false,
    });
    const match = (result["matches"] as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    expect(match).toMatchObject({
      id: "GHSA-lodash",
      aliases: ["CVE-2020-8203"],
      package: { ecosystem: "npm", name: "lodash", version: "4.17.15", lockfile: "bun.lock" },
      affectedRange: "all versions, < 4.17.21",
      fixedVersion: "4.17.21",
      versionInAffectedRange: true,
      versionListedExplicitly: true,
      // The distinction the whole tool turns on: OSV says the version is in a
      // declared range; nothing here says the code is reachable.
      reachabilityAnalyzed: false,
    });
    expect(match["severity"]).toMatchObject({ baseScore: 9.8, rating: "CRITICAL", label: "HIGH" });
    expect(String(result["method"])).toContain("NOT that the vulnerable code is reachable");
    // One batch for the query, one hydration for the single id.
    expect(
      calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/api\.osv\.dev/, "")}`),
    ).toEqual(["POST /v1/querybatch", "GET /v1/vulns/GHSA-lodash"]);
  });

  test("a clean lockfile says no advisory MATCHED, not that it is safe", async () => {
    writeBunLock({ "left-pad": "1.3.0" });
    mountOsv({});
    const result = await call(dependencyAudit, {});
    expect(result).toMatchObject({ matchCount: 0, noAdvisoriesMatched: true, matches: [] });
    expect(String(result["method"])).toContain("packages listed in `notes` as not audited");
  });

  test("cargo coordinates are sent to OSV as crates.io", async () => {
    writeFileSync(
      join(workspace, "Cargo.lock"),
      'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.100"\n',
    );
    const calls = mountOsv({});
    await call(dependencyAudit, {});
    expect((calls[0]?.body as { queries: unknown[] }).queries).toEqual([
      { package: { name: "serde", ecosystem: "crates.io" }, version: "1.0.100" },
    ]);
  });

  test("an ecosystem filter narrows what is queried", async () => {
    writeBunLock({ lodash: "4.17.15" });
    writeFileSync(
      join(workspace, "Cargo.lock"),
      'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.100"\n',
    );
    const calls = mountOsv({});
    const result = await call(dependencyAudit, { ecosystems: ["cargo"] });
    expect(result["packagesQueried"]).toBe(1);
    expect(
      (calls[0]?.body as { queries: Array<{ package: { name: string } }> }).queries[0]?.package
        .name,
    ).toBe("serde");
  });

  test("queries are batched rather than sent one request per package", async () => {
    const packages: Record<string, string> = {};
    for (let n = 0; n < 300; n += 1) packages[`pkg-${n}`] = "1.0.0";
    writeBunLock(packages);
    const calls = mountOsv({});
    const result = await call(dependencyAudit, {});
    expect(result["packagesQueried"]).toBe(300);
    // 300 coordinates at a batch size of 250: two requests, not three hundred.
    expect(result["batches"]).toBe(2);
    expect(calls.length).toBe(2);
    expect((calls[0]?.body as { queries: unknown[] }).queries.length).toBe(250);
    expect((calls[1]?.body as { queries: unknown[] }).queries.length).toBe(50);
  });

  test("severity ordering puts the worst first and keeps the unrated", async () => {
    writeBunLock({ a: "1.0.0", b: "1.0.0", c: "1.0.0" });
    mountOsv({
      matches: { "a@1.0.0": ["LOW-1"], "b@1.0.0": ["CRIT-1"], "c@1.0.0": ["NONE-1"] },
      records: {
        "LOW-1": {
          id: "LOW-1",
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N" }],
          affected: [],
        },
        "CRIT-1": {
          id: "CRIT-1",
          severity: [{ type: "CVSS_V3", score: SEVERITY_9_8 }],
          affected: [],
        },
        "NONE-1": { id: "NONE-1", affected: [] },
      },
    });
    const all = await call(dependencyAudit, {});
    expect((all["matches"] as Array<{ id: string }>).map((m) => m.id)).toEqual([
      "CRIT-1",
      "LOW-1",
      "NONE-1",
    ]);
    const filtered = await call(dependencyAudit, { minSeverity: "high" });
    // An advisory OSV recorded no severity for is not a low-severity one, so
    // the filter keeps it and says how many it kept.
    expect((filtered["matches"] as Array<{ id: string }>).map((m) => m.id)).toEqual([
      "CRIT-1",
      "NONE-1",
    ]);
    expect(filtered["unratedKeptByFilter"]).toBe(1);
  });

  test("a withdrawn advisory is reported as withdrawn rather than dropped", async () => {
    writeBunLock({ a: "1.0.0" });
    mountOsv({
      matches: { "a@1.0.0": ["W-1"] },
      records: { "W-1": { id: "W-1", withdrawn: "2024-01-01T00:00:00Z", affected: [] } },
    });
    const result = await call(dependencyAudit, {});
    const match = (result["matches"] as Array<Record<string, unknown>>)[0];
    expect(match?.["withdrawn"]).toBe("2024-01-01T00:00:00Z");
    expect(String(match?.["withdrawnNote"])).toContain("withdrawn upstream");
  });

  test("an id OSV will not serve is reported as a match with no detail", async () => {
    writeBunLock({ a: "1.0.0" });
    mountOsv({ matches: { "a@1.0.0": ["GONE-1"] }, vulnStatus: { "GONE-1": 404 } });
    const result = await call(dependencyAudit, {});
    expect(result["matchCount"]).toBe(1);
    const match = (result["matches"] as Array<Record<string, unknown>>)[0];
    expect(match?.["versionInAffectedRange"]).toBe(true);
    expect(String(match?.["detailsUnavailable"])).toContain("did not serve its record");
    expect((result["notes"] as string[]).join(" ")).toContain("GONE-1");
  });

  test("more packages than the cap leaves a note saying the rest were NOT audited", async () => {
    const packages: Record<string, string> = {};
    for (let n = 0; n < 10; n += 1) packages[`pkg-${n}`] = "1.0.0";
    writeBunLock(packages);
    mountOsv({});
    const result = await call(dependencyAudit, { maxPackages: 4 });
    expect(result).toMatchObject({ packagesQueried: 4, packagesFound: 10 });
    expect((result["notes"] as string[]).join(" ")).toContain("NOT audited");
  });

  test("past the hydration cap a match is still reported, with the reason it has no detail", async () => {
    const packages: Record<string, string> = {};
    const matches: Record<string, string[]> = {};
    const records: Record<string, unknown> = {};
    for (let n = 0; n < 310; n += 1) {
      const id = `GHSA-${String(n).padStart(4, "0")}`;
      packages[`pkg-${n}`] = "1.0.0";
      matches[`pkg-${n}@1.0.0`] = [id];
      records[id] = { id, affected: [] };
    }
    writeBunLock(packages);
    const calls = mountOsv({ matches, records });
    const result = await call(dependencyAudit, { maxAdvisories: 500 });
    expect(result).toMatchObject({ matchCount: 310, distinctAdvisories: 310 });
    // Two querybatch calls plus exactly the capped number of hydrations —
    // one request per advisory is what makes an old lockfile run for minutes.
    expect(calls.filter((c) => c.url.includes("/v1/vulns/")).length).toBe(300);
    const detail = (result["matches"] as Array<Record<string, unknown>>).filter(
      (m) => typeof m["detailsUnavailable"] === "string",
    );
    expect(detail.length).toBe(10);
    expect(String(detail[0]?.["detailsUnavailable"])).toContain("never requested");
    expect((result["notes"] as string[]).join(" ")).toContain("over the 300");
  }, 20_000); // pays for 310 in-memory OSV round trips on a loaded runner

  test("a pagination token on one package is surfaced", async () => {
    writeBunLock({ a: "1.0.0" });
    _setFetch(
      async () =>
        new Response(
          JSON.stringify({ results: [{ vulns: [{ id: "X" }], next_page_token: "more" }] }),
          { status: 200 },
        ),
    );
    const result = await call(dependencyAudit, {});
    expect((result["notes"] as string[]).join(" ")).toContain("paginated");
  });
});

describe("DependencyAudit — saying no", () => {
  test("a directory with no readable lockfile is refused, and the refusal names the formats", async () => {
    const message = await raw(dependencyAudit, {});
    expect(message).toContain("found no readable lockfile");
    expect(message).toContain("bun.lock");
    expect(message).toContain("Cargo.lock");
  });

  test("a path outside the workspace is refused before any syscall on it", async () => {
    for (const cwd of ["../..", "/etc"]) {
      expect(await raw(dependencyAudit, { cwd })).toContain("resolves outside the workspace root");
    }
  });

  test("a symlink inside the workspace pointing out of it is refused too", async () => {
    // A lexical check alone passes this: the path has no `..` in it.
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/etc", join(workspace, "escape"));
    expect(await raw(dependencyAudit, { cwd: "escape" })).toContain(
      "resolves outside the workspace root",
    );
  });

  test("a path that is missing, or is a file, is refused with which it was", async () => {
    expect(await raw(dependencyAudit, { cwd: "nope" })).toContain("nothing exists at that path");
    writeFileSync(join(workspace, "afile"), "x");
    expect(await raw(dependencyAudit, { cwd: "afile" })).toContain("is not a directory");
  });

  test("a lockfile with no reader is named as NOT audited rather than passed over", async () => {
    writeBunLock({ a: "1.0.0" });
    writeFileSync(join(workspace, "bun.lockb"), "binary");
    writeFileSync(join(workspace, "go.sum"), "example.com/m v1.0.0 h1:abc=\n");
    mountOsv({});
    const notes = ((await call(dependencyAudit, {}))["notes"] as string[]).join(" ");
    expect(notes).toContain("bun.lockb");
    expect(notes).toContain("go.sum");
    expect(notes).toContain("NOT audited");
  });

  test("no name this package calls unaudited is one tool-code can actually read", async () => {
    // The drift this guards: the widened readers added pnpm-lock.yaml, and a
    // stale local copy of the old name list would keep reporting it as
    // unaudited while it was being audited. The hit count is asserted so the
    // guard cannot pass by checking nothing.
    expect(LOCKFILE_NAMES.length).toBeGreaterThan(4);
    let checked = 0;
    for (const name of LOCKFILE_NAMES) {
      rmSync(join(workspace, "bun.lock"), { force: true });
      writeFileSync(join(workspace, name), name === "yarn.lock" ? "" : "{}");
      mountOsv({});
      const message = await raw(dependencyAudit, {});
      expect({
        name,
        unaudited: message.includes(`${name} `) && message.includes("NOT audited"),
      }).toEqual({ name, unaudited: false });
      rmSync(join(workspace, name), { force: true });
      checked += 1;
    }
    expect(checked).toBe(LOCKFILE_NAMES.length);
  });

  test("the report order is the same on every machine, not the runtime's collator", async () => {
    // `localeCompare` reads the process's default locale and ICU build:
    // en-US puts `a_b` before `a-b` and code-unit order puts `a-b` first.
    // `maxAdvisories` truncates this list, so the comparator decides which
    // matches are REPORTED, not just what order they appear in.
    expect(Math.sign("a_b".localeCompare("a-b"))).toBe(-1);
    expect(Math.sign("GHSA-B".localeCompare("GHSA-a"))).toBe(1);
    writeBunLock({ "a-b": "1.0.0", a_b: "1.0.0" });
    const unrated = (id: string, name: string) => ({
      id,
      affected: [{ package: { ecosystem: "npm", name }, ranges: [] }],
    });
    mountOsv({
      matches: {
        "a-b@1.0.0": ["GHSA-B", "GHSA-a"],
        "a_b@1.0.0": ["GHSA-B"],
      },
      records: {
        "GHSA-B": unrated("GHSA-B", "a-b"),
        "GHSA-a": unrated("GHSA-a", "a-b"),
      },
    });
    const result = await call(dependencyAudit, {});
    const order = (result["matches"] as Array<{ id: string; package: { name: string } }>).map(
      (m) => `${m.package.name}/${m.id}`,
    );
    expect(order).toEqual(["a-b/GHSA-B", "a-b/GHSA-a", "a_b/GHSA-B"]);
  });

  test("a record that names a different advisory is discarded, not attributed", async () => {
    // Same alignment rule querybatch already had: the response does not get to
    // say which advisory it is about. Keying the hydration map on `record.id`
    // filed the record served for one id under whatever id the body claimed —
    // handing one advisory's severity and fix to another, and racing the real
    // owner of that slot for it.
    writeBunLock({ lodash: "4.17.15" });
    mountOsv({
      matches: { "lodash@4.17.15": ["GHSA-wrongid"] },
      records: {
        "GHSA-wrongid": { ...lodashAdvisory, id: "GHSA-someone-else" },
      },
    });
    const result = await call(dependencyAudit, {});
    const match = (result["matches"] as Array<Record<string, unknown>>)[0];
    expect(match?.["id"]).toBe("GHSA-wrongid");
    expect(match?.["severity"]).toBeUndefined();
    expect(String(match?.["detailsUnavailable"])).toContain("named a DIFFERENT advisory");
    expect((result["notes"] as string[]).join(" ")).toContain("GHSA-wrongid");
  });

  test("a lockfile that is a symlink out of the workspace is not read or sent", async () => {
    // The contents of this file would otherwise be parsed and its package
    // names POSTed to OSV — an out-of-workspace read with an egress channel
    // attached, refused when `cwd` names it and not when it is discovered.
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-outside-"));
    const { symlinkSync } = await import("node:fs");
    writeFileSync(
      join(outside, "hidden.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/private-internal-pkg": { version: "1.0.0" } },
      }),
    );
    symlinkSync(join(outside, "hidden.json"), join(workspace, "package-lock.json"));
    try {
      const calls = mountOsv({});
      const message = await raw(dependencyAudit, {});
      expect(calls.length).toBe(0);
      expect(message).toContain("resolves outside the workspace root");
      expect(message).not.toContain("private-internal-pkg");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an ecosystem filter that matches nothing says nothing was queried", async () => {
    writeBunLock({ lodash: "4.17.15" });
    const message = await raw(dependencyAudit, { ecosystems: ["cargo"] });
    expect(message).toContain("no package matched the requested ecosystems (cargo)");
  });

  test("a lockfile that locks nothing is a refusal, not a zero that reads as clean", async () => {
    writeBunLock({});
    expect(await raw(dependencyAudit, {})).toContain("found no locked package");
  });

  test("an HTTP failure is an ERROR, never an empty, reassuring answer", async () => {
    writeBunLock({ a: "1.0.0" });
    _setFetch(async () => new Response("upstream is down", { status: 503 }));
    // A report that came back clean because the database was unreachable is
    // the single worst thing this tool could return.
    await expect(raw(dependencyAudit, {})).rejects.toThrow("HTTP 503");
    await expect(raw(dependencyAudit, {})).rejects.toThrow("no part of this lockfile was audited");
  });

  test("a rate limit says so, because the fix is to wait rather than to change anything", async () => {
    writeBunLock({ a: "1.0.0" });
    _setFetch(async () => new Response("slow down", { status: 429 }));
    await expect(raw(dependencyAudit, {})).rejects.toThrow("rate limit");
  });

  test("a body that is not JSON is an error naming that, not a parse crash", async () => {
    writeBunLock({ a: "1.0.0" });
    _setFetch(async () => new Response("<html>proxy error</html>", { status: 200 }));
    await expect(raw(dependencyAudit, {})).rejects.toThrow("not JSON");
  });

  test("a body bigger than the cap is abandoned rather than buffered", async () => {
    // The one documented refusal in this package that nothing exercised. A
    // self-hosted mirror decides how many bytes arrive, and `res.text()`
    // buffers all of them — the streaming counter is the only version of this
    // that has a limit, and an untested limit is a limit that has never run.
    writeBunLock({ a: "1.0.0" });
    const pad = "x".repeat(17 * 1024 * 1024);
    _setFetch(async () => new Response(`{"results":[{"pad":"${pad}"}]}`, { status: 200 }));
    await expect(raw(dependencyAudit, {})).rejects.toThrow("abandoned rather than buffered");
  }, 20_000); // pays for building and streaming a 17MB body on a slow runner

  test("a response whose length does not match the query is refused", async () => {
    writeBunLock({ a: "1.0.0", b: "2.0.0" });
    _setFetch(async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }));
    // Results are positional, so a short array would attribute one package's
    // advisories to another.
    await expect(raw(dependencyAudit, {})).rejects.toThrow("by position");
  });

  test("a transport failure names the host it could not reach", async () => {
    writeBunLock({ a: "1.0.0" });
    _setFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(raw(dependencyAudit, {})).rejects.toThrow("could not reach https://api.osv.dev");
  });

  test("a timeout reports the TIMEOUT, not merely a failure", async () => {
    writeBunLock({ a: "1.0.0" });
    // A bare rejection is what a cancellation looks like too, so the reason
    // has to be in the message or the two are indistinguishable.
    _setFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(raw(dependencyAudit, { timeoutMs: 25 })).rejects.toThrow("did not answer");
    await expect(raw(dependencyAudit, { timeoutMs: 25 })).rejects.toThrow("within 25ms");
  });

  test("a cancelled call says it was cancelled, not that it timed out", async () => {
    writeBunLock({ a: "1.0.0" });
    mountOsv({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      raw(dependencyAudit, { timeoutMs: 30_000 }, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});

describe("DependencyAudit — where it is allowed to go", () => {
  test("with no endpoint it goes to the public OSV API and asks no resolver", async () => {
    writeBunLock({ a: "1.0.0" });
    const calls = mountOsv({});
    // The default host is a constant, so there is no DNS lookup to stub and
    // nothing for a test to depend on.
    _setDnsLookup(async () => {
      throw new Error("the default endpoint must not be resolved");
    });
    const result = await call(dependencyAudit, {});
    expect(result["endpoint"]).toBe("https://api.osv.dev");
    expect(calls[0]?.url.startsWith("https://api.osv.dev/")).toBe(true);
  });

  test("naming the default endpoint explicitly behaves exactly like omitting it", async () => {
    writeBunLock({ a: "1.0.0" });
    const calls = mountOsv({});
    _setDnsLookup(async () => {
      throw new Error("the default endpoint must not be resolved");
    });
    const result = await call(dependencyAudit, { endpoint: "https://api.osv.dev" });
    expect(result["endpoint"]).toBe("https://api.osv.dev");
    expect(calls[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
  });

  test("an endpoint the operator did not allow-list is refused", async () => {
    writeBunLock({ a: "1.0.0" });
    mountOsv({});
    const message = await raw(dependencyAudit, { endpoint: "https://osv.internal.example" });
    expect(message).toContain("not in the operator's fetch allow-list");
    expect(message).toContain("tool_config.fetch.allowed_origins");
  });

  test("an allow-listed mirror is used, and the request goes there", async () => {
    writeBunLock({ a: "1.0.0" });
    const calls = mountOsv({});
    registerFetchConfig({ allowed_origins: ["https://osv.internal.example"] });
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    const result = await call(dependencyAudit, { endpoint: "https://osv.internal.example/" });
    expect(result["endpoint"]).toBe("https://osv.internal.example");
    expect(calls[0]?.url).toBe("https://osv.internal.example/v1/querybatch");
  });

  test("an allow-listed origin that resolves somewhere private is still refused", async () => {
    writeBunLock({ a: "1.0.0" });
    mountOsv({});
    registerFetchConfig({ allowed_origins: ["https://osv.internal.example"] });
    // Allow-listing is not a bypass for the SSRF check; both gates run.
    _setDnsLookup(async () => ({ address: "169.254.169.254", family: 4 }));
    expect(await raw(dependencyAudit, { endpoint: "https://osv.internal.example" })).toContain(
      "SSRF",
    );
  });

  test("loopback and a malformed origin are refused without a lookup", async () => {
    writeBunLock({ a: "1.0.0" });
    mountOsv({});
    registerFetchConfig({ allowed_origins: ["http://localhost:8080", "https://osv.example"] });
    expect(await raw(dependencyAudit, { endpoint: "http://localhost:8080" })).toContain("loopback");
    expect(await raw(dependencyAudit, { endpoint: "not a url" })).toContain(
      "not a usable http(s) origin",
    );
    expect(await raw(dependencyAudit, { endpoint: "file:///etc/passwd" })).toContain(
      "not a usable http(s) origin",
    );
  });
});

// ---------------------------------------------------------------------------

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

function writeWorkflow(name: string, body: string): void {
  mkdirSync(join(workspace, ".github/workflows"), { recursive: true });
  writeFileSync(join(workspace, ".github/workflows", name), body);
}

const RISKY = [
  "name: Risky",
  "on:",
  "  pull_request_target:",
  "    types: [opened]",
  "permissions: write-all",
  "jobs:",
  "  build:",
  "    runs-on: [self-hosted, linux]",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "        with:",
  "          ref: ${{ github.event.pull_request.head.sha }}",
  "      - name: Greet",
  "        run: echo ${{ github.event.issue.title }}",
  "",
].join("\n");

describe("CiWorkflowAudit", () => {
  test("it finds every rule's defect in one file, with the line of each", async () => {
    writeWorkflow("risky.yml", RISKY);
    const result = await call(ciWorkflowAudit, { repositoryVisibility: "public" });
    expect(result).toMatchObject({
      files: [".github/workflows/risky.yml"],
      workflows: 1,
      jobs: 1,
      steps: 2,
      actionReferences: 1,
      actionsPinnedToCommit: 0,
      noFindings: false,
    });
    const findings = result["findings"] as Array<Record<string, unknown>>;
    const byRule = new Map(findings.map((f) => [f["rule"], f]));
    expect([...byRule.keys()].sort()).toEqual([
      "broad-permissions",
      "pull-request-target-checkout",
      "script-injection",
      "self-hosted-runner",
      "unpinned-action",
    ]);
    expect(byRule.get("pull-request-target-checkout")).toMatchObject({
      severity: "critical",
      line: 12,
      job: "build",
      step: "step #1",
    });
    expect(byRule.get("script-injection")).toMatchObject({ line: 14, step: "Greet" });
    expect(byRule.get("unpinned-action")).toMatchObject({ line: 10 });
    expect(result["bySeverity"]).toMatchObject({ critical: 3, high: 2 });
  });

  test("a well-formed workflow produces nothing, and says what that means", async () => {
    writeWorkflow(
      "clean.yml",
      [
        "name: CI",
        "on: push",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: actions/checkout@${SHA}`,
        "      - run: bun test",
        "",
      ].join("\n"),
    );
    const result = await call(ciWorkflowAudit, { repositoryVisibility: "public" });
    expect(result).toMatchObject({ findingCount: 0, noFindings: true, actionsPinnedToCommit: 1 });
    expect(String(result["method"])).toContain("Read `parseWarnings`");
  });

  test("severity and count limits narrow the report without hiding the total", async () => {
    writeWorkflow("risky.yml", RISKY);
    const filtered = await call(ciWorkflowAudit, {
      repositoryVisibility: "public",
      minSeverity: "critical",
    });
    expect((filtered["findings"] as unknown[]).length).toBe(3);
    // The name of this test is the assertion: the threshold must not be able
    // to manufacture a clean answer. `noFindings` counts what the RULES found,
    // the filter says it ran, and it says how many it dropped.
    expect(filtered).toMatchObject({
      noFindings: false,
      minSeverity: "critical",
      findingsBelowMinSeverity: 2,
    });
    const capped = await call(ciWorkflowAudit, { repositoryVisibility: "public", maxFindings: 2 });
    expect(capped).toMatchObject({ findingCount: 5, findingsTruncated: true });
    expect((capped["findings"] as unknown[]).length).toBe(2);
  });

  test("a threshold above every finding still reports the file as NOT clean", async () => {
    // The shape a harness gates on. Five real findings, none of them critical:
    // `noFindings: true` with nothing else in the object mentioning a filter
    // was a suppressed report that read exactly like a passing one.
    writeWorkflow(
      "medium.yml",
      ["on: push", "jobs:", "  b:", "    steps:", "      - uses: actions/checkout@v4", ""].join(
        "\n",
      ),
    );
    const result = await call(ciWorkflowAudit, { minSeverity: "critical" });
    expect(result).toMatchObject({
      findingCount: 0,
      noFindings: false,
      minSeverity: "critical",
      findingsBelowMinSeverity: 2,
    });
    expect(String(result["method"])).toContain("BEFORE any `minSeverity` filter");
  });

  test("a workflow file that is a symlink out of the workspace is refused", async () => {
    // The same file is refused when `path` names it. Reaching it through the
    // directory listing has to refuse it too, or the boundary only holds for
    // callers who spell the path out.
    const { symlinkSync, mkdirSync: mk } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-outside-"));
    writeFileSync(
      join(outside, "elsewhere.yml"),
      ["on: push", "jobs:", "  j:", "    steps:", "      - uses: evil/action@main", ""].join("\n"),
    );
    mk(join(workspace, ".github/workflows"), { recursive: true });
    symlinkSync(join(outside, "elsewhere.yml"), join(workspace, ".github/workflows/link.yml"));
    try {
      expect(await raw(ciWorkflowAudit, { path: ".github/workflows/link.yml" })).toContain(
        "resolves outside the workspace root",
      );
      const viaDirectory = await raw(ciWorkflowAudit, {});
      expect(viaDirectory).not.toContain("evil/action");
      expect(viaDirectory).toContain("refused");
      expect(viaDirectory).toContain("link.yml");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("only the requested rules run, and the result says which", async () => {
    writeWorkflow("risky.yml", RISKY);
    const result = await call(ciWorkflowAudit, { rules: ["script-injection"] });
    expect(result["rulesRun"]).toEqual(["script-injection"]);
    expect(new Set((result["findings"] as Array<{ rule: string }>).map((f) => f.rule))).toEqual(
      new Set(["script-injection"]),
    );
  });

  test("the inventory reports pin state for every reference, on request", async () => {
    writeWorkflow(
      "mixed.yml",
      [
        "on: push",
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: actions/checkout@${SHA}`,
        "      - uses: docker://alpine:3.19",
        "      - uses: ./.github/actions/local",
        "",
      ].join("\n"),
    );
    const result = await call(ciWorkflowAudit, { includeInventory: true });
    expect(result["inventory"]).toEqual([
      expect.objectContaining({
        uses: `actions/checkout@${SHA}`,
        refKind: "commit-sha",
        pinned: true,
      }),
      expect.objectContaining({ uses: "docker://alpine:3.19", kind: "docker", pinned: false }),
      expect.objectContaining({ uses: "./.github/actions/local", kind: "local", pinned: true }),
    ]);
    const plain = await call(ciWorkflowAudit, {});
    expect(plain["inventory"]).toBeUndefined();
  });

  test("a runner it cannot classify is counted, never reported as a finding or as clean", async () => {
    writeWorkflow(
      "matrix.yml",
      [
        "on: push",
        "permissions: {}",
        "jobs:",
        "  j:",
        "    runs-on: ${{ matrix.os }}",
        "    steps:",
        "      - run: bun test",
        "",
      ].join("\n"),
    );
    const result = await call(ciWorkflowAudit, { repositoryVisibility: "public" });
    expect(result["runnersUndetermined"]).toBe(1);
    expect(
      (result["findings"] as Array<{ rule: string }>).some((f) => f.rule === "self-hosted-runner"),
    ).toBe(false);
  });

  test("a conditional finding is counted as conditional", async () => {
    writeWorkflow(
      "selfhosted.yml",
      [
        "on: push",
        "permissions: {}",
        "jobs:",
        "  j:",
        "    runs-on: self-hosted",
        "    steps:",
        "      - run: bun test",
        "",
      ].join("\n"),
    );
    const unknown = await call(ciWorkflowAudit, {});
    expect(unknown["conditionalFindings"]).toBe(1);
    expect((unknown["findings"] as Array<{ conditionalOn?: string }>)[0]?.conditionalOn).toContain(
      "public",
    );
    const known = await call(ciWorkflowAudit, { repositoryVisibility: "public" });
    expect(known["conditionalFindings"]).toBeUndefined();
  });

  test("everything the YAML reader could not account for comes back as a warning", async () => {
    writeWorkflow(
      "odd.yml",
      "on: push\njobs:\n  j:\n    steps:\n      - run: x\n---\nsecond: doc\n",
    );
    const result = await call(ciWorkflowAudit, {});
    const codes = (result["parseWarnings"] as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toContain("multiple-documents");
    expect((result["parseWarnings"] as Array<{ file: string }>)[0]?.file).toBe(
      ".github/workflows/odd.yml",
    );
  });

  test("every workflow in the directory is read, sorted, and non-YAML is left alone", async () => {
    writeWorkflow("b.yml", "on: push\npermissions: {}\n");
    writeWorkflow("a.yaml", "on: push\npermissions: {}\n");
    writeWorkflow("README.md", "not a workflow\n");
    mkdirSync(join(workspace, ".github/workflows/nested"), { recursive: true });
    writeFileSync(join(workspace, ".github/workflows/nested/deep.yml"), "on: push\n");
    const result = await call(ciWorkflowAudit, {});
    // GitHub reads only the top level of this directory, so recursing would
    // report findings on files the runner never executes.
    expect(result["files"]).toEqual([".github/workflows/a.yaml", ".github/workflows/b.yml"]);
  });

  test("a single file can be audited directly", async () => {
    writeWorkflow("risky.yml", RISKY);
    const result = await call(ciWorkflowAudit, { path: ".github/workflows/risky.yml" });
    expect(result["files"]).toEqual([".github/workflows/risky.yml"]);
    expect(result["findingCount"]).toBeGreaterThan(0);
  });
});

describe("CiWorkflowAudit — saying no", () => {
  test("no workflow directory is a refusal that says where it looked", async () => {
    const message = await raw(ciWorkflowAudit, {});
    expect(message).toContain(".github/workflows");
    expect(message).toContain("Pass `path`");
  });

  test("a path outside the workspace is refused", async () => {
    expect(await raw(ciWorkflowAudit, { path: "../../etc" })).toContain(
      "resolves outside the workspace root",
    );
    expect(await raw(ciWorkflowAudit, { path: "/etc" })).toContain(
      "resolves outside the workspace root",
    );
  });

  test("a named path that does not exist is refused, naming it", async () => {
    expect(await raw(ciWorkflowAudit, { path: "ci" })).toContain('refused "ci"');
  });

  test("a directory with no YAML in it says nothing was audited", async () => {
    mkdirSync(join(workspace, "ci"), { recursive: true });
    writeFileSync(join(workspace, "ci/notes.txt"), "hello");
    expect(await raw(ciWorkflowAudit, { path: "ci" })).toContain("nothing was audited");
  });

  test("a file too large to be a workflow is listed as unreadable, not silently skipped", async () => {
    writeWorkflow("huge.yml", `# ${"x".repeat(4 * 1024 * 1024 + 10)}\n`);
    writeWorkflow("ok.yml", "on: push\npermissions: {}\n");
    const result = await call(ciWorkflowAudit, {});
    expect(result["unreadableFiles"]).toEqual([".github/workflows/huge.yml"]);
    expect(result["workflows"]).toBe(1);
  }, 20_000); // pays for writing and reading a 4 MB file on a loaded runner
});
