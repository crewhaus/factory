/**
 * 0.7.1 hardening — the matcher cannot be dodged.
 *
 * Four things the 0.7.0 matcher got wrong, each pinned here:
 *
 *  1. It compiled a glob to a backtracking RegExp. `Bash(*git*push*--force*)`
 *     against an 18 KB command took twelve seconds on the event loop.
 *  2. It read allow, deny and ask rules the same way, so a deny needed EVERY
 *     string in the input to match and one extra argument dodged it.
 *  3. For Read/Write/Edit/Grep an allow was satisfied by ANY listed field,
 *     so a matching decoy `file_path` authorised the real `path`.
 *  4. It matched the literal string, so `build/../src` passed `build/**`.
 *     (Canonicalisation itself happens in the runtime; here we pin how the
 *     matcher reads the values the runtime hands it.)
 */
import { describe, expect, test } from "bun:test";
import {
  type OperativeValue,
  compilePattern,
  legacyMcpToolName,
  matchesPattern,
  matchesToolName,
} from "./index";

// ---------------------------------------------------------------------------
// The 0.7.0 compiler, kept verbatim as the ORACLE for the language the new
// automaton must accept. Any difference on any glob/value pair is a bug in the
// rewrite (or a deliberate grammar change, which this test would force into
// the open).
// ---------------------------------------------------------------------------
type GlobPos = "start" | "sep" | "other";
function oracleGlobToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  let pos: GlobPos = "start";
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      const lit = glob.charAt(i + 1);
      re += lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pos = lit === "/" ? "sep" : "other";
      i += 2;
    } else if (ch === "*" && glob[i + 1] === "*") {
      const afterTwo = glob[i + 2];
      if (afterTwo === "/" && pos === "start") {
        re += "(?:.*/)?";
        pos = "start";
        i += 3;
      } else if (afterTwo === "/" && pos === "sep") {
        re = `${re.slice(0, -1)}(?:/.*/|/)`;
        pos = "start";
        i += 3;
      } else if (afterTwo === undefined && pos === "sep") {
        re = `${re.slice(0, -1)}(?:/.*)?`;
        pos = "other";
        i += 2;
      } else {
        re += ".*";
        pos = "other";
        i += 2;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      pos = "other";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      pos = "other";
      i++;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      pos = ch === "/" ? "sep" : "other";
      i++;
    }
  }
  return new RegExp(`^${re}$`, "s");
}

/** Deterministic PRNG so a failure reproduces. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the linear-time glob accepts exactly the old regex's language", () => {
  test("randomised differential against the 0.7.0 compiler", () => {
    const rand = prng(0x5eed);
    const globAlphabet = ["a", "b", "/", "*", "**", "?", "\\", "\\*", ".", "(", "[", "\n"];
    const valueAlphabet = ["a", "b", "/", ".", "*", "?", "\\", "\n", "(", "["];
    let compared = 0;
    let matched = 0;
    for (let g = 0; g < 1500; g++) {
      let glob = "";
      const glen = 1 + Math.floor(rand() * 7);
      for (let i = 0; i < glen; i++) {
        glob += globAlphabet[Math.floor(rand() * globAlphabet.length)];
      }
      const oracle = oracleGlobToRegex(glob);
      const compiled = compilePattern(`T(${glob})`);
      const argRe = compiled._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (let v = 0; v < 40; v++) {
        let value = "";
        const vlen = Math.floor(rand() * 8);
        for (let i = 0; i < vlen; i++) {
          value += valueAlphabet[Math.floor(rand() * valueAlphabet.length)];
        }
        const want = oracle.test(value);
        if (argRe.test(value) !== want) {
          throw new Error(
            `glob ${JSON.stringify(glob)} vs ${JSON.stringify(value)}: oracle=${want} new=${!want}`,
          );
        }
        compared++;
        if (want) matched++;
      }
    }
    // A differential that never compares a MATCH proves nothing about matches.
    expect(compared).toBe(1500 * 40);
    expect(matched).toBeGreaterThan(2000);
  });
});

describe("security-8#2 — a glob cannot stall the event loop", () => {
  // The audit's reproductions. Under the old regex the first took 12 s at
  // 18 KB (cubic), and the second did not finish inside 110 s at 20 KB.
  //
  // They run in a CHILD process with a kill timer. A backtracking matcher
  // blocks the thread it runs on, so run in-process it would hang this test
  // instead of failing it — the event loop that would fire the timeout is the
  // thing that is stuck.
  //
  // Linear time is checked by COUNTING the work, not by timing it: each rule
  // runs on an argument and on one sixteen times longer, and the matcher
  // reports how many automaton states it visited. Linear means sixteen times
  // the steps. A clock cannot say that reliably on a busy runner — in a full
  // `bun run test` a wall-clock ratio of this same code measured 261.
  test("wildcard-heavy rules against long arguments finish in linear time", async () => {
    const script = `
        import { compilePattern, matchesPattern } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};
        const cases = [
          ["Bash(*git*push*--force*)", (k) => "git push --force origin main ; " + "git push ".repeat(k), 1000],
          ["Bash(*a*b*c*d*)", (k) => "a".repeat(k), 12500],
          ["Bash(**curl**|**sh**)", (k) => "curl ".repeat(k), 2500],
          ["Bash(*a*a*a*a*a*a*a*a*b)", (k) => "a".repeat(k) + "b", 6250],
        ];
        const out = [];
        for (const [pattern, make, k] of cases) {
          const p = compilePattern(pattern);
          const short = make(k);
          const long = make(16 * k);
          const small = { steps: 0 };
          const large = { steps: 0 };
          p._argRe.test(short, small);
          p._argRe.test(long, large);
          out.push({
            pattern,
            length: long.length,
            answer: matchesPattern(p, "Bash", { command: long }),
            small: small.steps,
            large: large.steps,
          });
        }
        console.log(JSON.stringify(out));
      `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 45_000);
    const code = await child.exited;
    clearTimeout(killer);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    // A kill here means the matcher did not get through the inputs in 45 s:
    // it is backtracking again (the old regex never finished the second one).
    expect({ killed, code, stderr }).toEqual({ killed: false, code: 0, stderr: "" });
    const rows = JSON.parse(stdout) as Array<{
      pattern: string;
      length: number;
      answer: boolean;
      small: number;
      large: number;
    }>;
    // The answers are what they always were; only the cost changed.
    expect(rows.map((r) => r.answer)).toEqual([true, false, false, true]);
    for (const r of rows) {
      // The inputs really are the audit's sizes, 100–200 KB, and the work was
      // counted (a matcher that reports nothing proves nothing)…
      expect(r.length).toBeGreaterThanOrEqual(100_000);
      expect(r.small).toBeGreaterThan(0);
      // …sixteen times the input is at most sixteen times the work, give or
      // take the fixed cost at either end (quadratic would be 256)…
      expect({ pattern: r.pattern, growth: r.large / r.small < 17 }).toEqual({
        pattern: r.pattern,
        growth: true,
      });
      // …and no character costs more than a few states per glob token.
      expect(r.large / r.length).toBeLessThan(r.pattern.length);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Polarity
// ---------------------------------------------------------------------------

const allow = { polarity: "allow" } as const;
const restrict = { polarity: "restrict" } as const;

describe("polarity — allow needs every value, deny/ask fire on any", () => {
  test("undeclared tool: an extra string no longer dodges a deny (permission-integration#0)", () => {
    const p = compilePattern("RemovePath(.git/**)");
    const honest = { path: ".git/hooks", recursive: true };
    const decoy = { path: ".git/hooks", recursive: true, reason: "cleanup" };
    expect(matchesPattern(p, "RemovePath", honest, restrict)).toBe(true);
    expect(matchesPattern(p, "RemovePath", decoy, restrict)).toBe(true);
    // …and an allow still needs every string, so the extra one blocks it.
    const scoped = compilePattern("RemovePath(.git/**)");
    expect(matchesPattern(scoped, "RemovePath", decoy, allow)).toBe(false);
  });

  test("undeclared tool: RunCommand deny fires on any argv element (flag-truth-4#0, security-8#0)", () => {
    const p = compilePattern("RunCommand(rm)");
    expect(matchesPattern(p, "RunCommand", { argv: ["rm", "-rf", "src"] }, restrict)).toBe(true);
    expect(matchesPattern(p, "RunCommand", { argv: ["rm"], cwd: "src" }, restrict)).toBe(true);
    expect(matchesPattern(p, "RunCommand", { argv: ["ls", "-la"] }, restrict)).toBe(false);
  });

  test("HttpRequest deny survives method/note additions", () => {
    const p = compilePattern("HttpRequest(http://169.254.169.254/**)");
    const url = "http://169.254.169.254/latest/meta-data/iam";
    for (const input of [{ url }, { url, method: "GET" }, { url, note: "x" }]) {
      expect(matchesPattern(p, "HttpRequest", input, restrict)).toBe(true);
    }
  });

  test("named-table alias decoy: allow needs every PRESENT operative field (security-1#0)", () => {
    const p = compilePattern("Write(src/**)");
    const decoy = { file_path: "src/ok.ts", path: ".crewhaus/settings.json", content: "x" };
    expect(matchesPattern(p, "Write", decoy, allow)).toBe(false);
    expect(matchesPattern(p, "Write", { path: "src/ok.ts", content: "x" }, allow)).toBe(true);
    // The deny side fires on either alias.
    const deny = compilePattern("Write(.crewhaus/**)");
    expect(matchesPattern(deny, "Write", decoy, restrict)).toBe(true);
  });

  test("Grep: a pattern decoy cannot carry an out-of-scope path (flag-truth-1#0)", () => {
    const p = compilePattern("Grep(src/**)");
    expect(matchesPattern(p, "Grep", { pattern: "src/x|password", path: "." }, allow)).toBe(false);
  });

  test("the default polarity is allow", () => {
    const p = compilePattern("Write(src/**)");
    const decoy = { file_path: "src/ok.ts", path: ".git/config" };
    expect(matchesPattern(p, "Write", decoy)).toBe(matchesPattern(p, "Write", decoy, allow));
  });

  test("a bare pattern ignores polarity; an input with no string matches no arg glob", () => {
    const bare = compilePattern("Lint");
    expect(matchesPattern(bare, "Lint", {}, allow)).toBe(true);
    expect(matchesPattern(bare, "Lint", {}, restrict)).toBe(true);
    const scoped = compilePattern("Lint(**)");
    expect(matchesPattern(scoped, "Lint", { fix: true }, allow)).toBe(false);
    expect(matchesPattern(scoped, "Lint", { fix: true }, restrict)).toBe(false);
  });
});

describe("undeclared strings with `..` segments (permission-integration#1 fallback)", () => {
  test("an allow never matches a `..` segment", () => {
    const p = compilePattern("RemovePath(build/**)");
    expect(matchesPattern(p, "RemovePath", { path: "build/../src" }, allow)).toBe(false);
    expect(matchesPattern(p, "RemovePath", { path: "build/out" }, allow)).toBe(true);
  });

  test("a deny sees the collapsed form, and fires outright on a climb out", () => {
    const p = compilePattern("RemovePath(.git/**)");
    expect(matchesPattern(p, "RemovePath", { path: "src/../.git/hooks" }, restrict)).toBe(true);
    expect(matchesPattern(p, "RemovePath", { path: "../elsewhere" }, restrict)).toBe(true);
    // `..` inside a name is not a segment.
    expect(matchesPattern(p, "RemovePath", { path: "notes..txt" }, restrict)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Declared operative values
// ---------------------------------------------------------------------------

const pathValue = (relative: string, absolute: string, raw = relative): OperativeValue => ({
  kind: "path",
  canonical: [relative, absolute],
  spellings: [raw],
});

describe("declared operative values", () => {
  test("they replace the input entirely: a decoy key in the input is never read", () => {
    const p = compilePattern("Write(src/**)");
    const values = [pathValue(".git/hooks/pre-commit", "/ws/.git/hooks/pre-commit")];
    expect(
      matchesPattern(p, "Write", { file_path: "src/ok.ts" }, { ...allow, operativeValues: values }),
    ).toBe(false);
  });

  test("an empty list means no operative value: no arg glob matches, either way", () => {
    const p = compilePattern("Grep(**)");
    expect(matchesPattern(p, "Grep", { pattern: "x" }, { ...allow, operativeValues: [] })).toBe(
      false,
    );
    expect(matchesPattern(p, "Grep", { pattern: "x" }, { ...restrict, operativeValues: [] })).toBe(
      false,
    );
  });

  test("outside the workspace: never an allow, always a deny", () => {
    const outside: OperativeValue = {
      kind: "path",
      canonical: [],
      spellings: ["../x"],
      outsideWorkspace: true,
    };
    expect(
      matchesPattern(
        compilePattern("Write(**)"),
        "Write",
        {},
        { ...allow, operativeValues: [outside] },
      ),
    ).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Write(.git/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [outside] },
      ),
    ).toBe(true);
  });

  test("an allow reads only canonical spellings; a deny also reads the raw ones", () => {
    // `build/link` is a symlink to `src`: the tool acts on src/app.ts.
    const v = pathValue("src/app.ts", "/ws/src/app.ts", "build/link/app.ts");
    expect(
      matchesPattern(
        compilePattern("Write(build/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Write(src/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(true);
    // A deny written against either name fires.
    expect(
      matchesPattern(
        compilePattern("Write(src/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [v] },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        compilePattern("Write(build/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [v] },
      ),
    ).toBe(true);
  });

  test("a path glob that starts with / sees the absolute spelling, any other glob the relative one", () => {
    const v = pathValue("proj.txt", "/home/me/src/ws/proj.txt");
    // `**/src/**` must not reach through the workspace's own location.
    expect(
      matchesPattern(
        compilePattern("Write(**/src/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Write(**/src/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [v] },
      ),
    ).toBe(false);
    // An absolute rule still works against the absolute spelling.
    expect(
      matchesPattern(
        compilePattern("Write(/home/me/src/ws/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(true);
  });

  test("every value must match an allow; any value fires a deny", () => {
    const a = pathValue("src/a.ts", "/ws/src/a.ts");
    const b = pathValue("docs/b.md", "/ws/docs/b.md");
    const p = compilePattern("CopyPath(src/**)");
    expect(matchesPattern(p, "CopyPath", {}, { ...allow, operativeValues: [a, b] })).toBe(false);
    expect(matchesPattern(p, "CopyPath", {}, { ...allow, operativeValues: [a] })).toBe(true);
    expect(matchesPattern(p, "CopyPath", {}, { ...restrict, operativeValues: [b, a] })).toBe(true);
  });

  test("non-path values are not filtered by absoluteness", () => {
    const cmd: OperativeValue = { kind: "command", canonical: ["/bin/ls -la"] };
    expect(
      matchesPattern(
        compilePattern("Bash(**ls**)"),
        "Bash",
        {},
        { ...allow, operativeValues: [cmd] },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP names (flag-truth-1#1)
// ---------------------------------------------------------------------------

describe("MCP tool names", () => {
  test("a documented mcp__ rule and a pre-0.7.1 rule both govern the registered name", () => {
    const name = "mcp__github__create_issue";
    for (const pattern of [
      "mcp__github__*",
      "mcp__github__create_issue",
      "github__*",
      "github__create_issue",
      "mcp__*",
    ]) {
      expect(matchesToolName(compilePattern(pattern), name)).toBe(true);
    }
    expect(matchesToolName(compilePattern("gitlab__*"), name)).toBe(false);
    expect(matchesToolName(compilePattern("mcp__gitlab__*"), name)).toBe(false);
  });

  test("the alias runs one way: an mcp__ rule never governs a non-MCP tool", () => {
    expect(matchesToolName(compilePattern("mcp__contract__fn"), "contract__fn")).toBe(false);
  });

  test("legacyMcpToolName needs a server and a tool", () => {
    expect(legacyMcpToolName("mcp__a__b")).toBe("a__b");
    expect(legacyMcpToolName("mcp____b")).toBeUndefined();
    expect(legacyMcpToolName("mcp__a__")).toBeUndefined();
    expect(legacyMcpToolName("a__b")).toBeUndefined();
  });

  test("matchesPattern applies the same name rule", () => {
    const p = compilePattern("github__create_issue");
    expect(matchesPattern(p, "mcp__github__create_issue", { title: "x" }, restrict)).toBe(true);
  });
});
