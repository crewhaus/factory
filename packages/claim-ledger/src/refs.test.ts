import { describe, expect, test } from "bun:test";
import { citationDefinitions } from "./citations";
import { classifyDefinition, definitionGloss, isAssumptionMarker } from "./refs";

describe("classifyDefinition — linear in the source", () => {
  // A source reaches this from the answer's definition lines and from every
  // url/link field of an MCP result (design §10; AGENTS.md pillar 3). The
  // least of three runs, timed against a URL of the same size with no
  // punctuation run, so a slow machine slows both.
  const fastest = (run: () => unknown): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      run();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const n = 200_000;

  test("a punctuation run inside a URL is read once", () => {
    // Trimming with /[.,;:!?]+$/ retried from every character of the run:
    // 80,000 dots then an "x" took four seconds.
    const dotted = `https://a.example/${".".repeat(n)}x`;
    const base = fastest(() => classifyDefinition(`https://a.example/${"y".repeat(n)}x`));
    expect(classifyDefinition(dotted)).toEqual({ kind: "url", url: dotted });
    expect(fastest(() => classifyDefinition(dotted))).toBeLessThan(base * 20 + 100);
    const bracketed = `<https://a.example/${";".repeat(n)}x>`;
    expect(fastest(() => classifyDefinition(bracketed))).toBeLessThan(base * 20 + 100);
  }, 20_000);

  test("the trailing run is still dropped, whatever its length", () => {
    expect(classifyDefinition(`https://a.example/x${".,;:!?".repeat(n / 6)}`)).toEqual({
      kind: "url",
      url: "https://a.example/x",
    });
    expect(classifyDefinition("https://a.example/a.b?c=d;e")).toEqual({
      kind: "url",
      url: "https://a.example/a.b?c=d;e",
    });
  });
});

describe("classifyDefinition — every kind", () => {
  test("url: http and https, first word, trailing sentence punctuation dropped", () => {
    expect(classifyDefinition("https://acme.example/policy")).toEqual({
      kind: "url",
      url: "https://acme.example/policy",
    });
    expect(classifyDefinition("HTTP://acme.example/a?b=c#d")).toEqual({
      kind: "url",
      url: "HTTP://acme.example/a?b=c#d",
    });
    expect(classifyDefinition("https://acme.example/policy — Acme refund policy")).toEqual({
      kind: "url",
      url: "https://acme.example/policy",
    });
    expect(classifyDefinition("https://acme.example/policy.")).toEqual({
      kind: "url",
      url: "https://acme.example/policy",
    });
    expect(classifyDefinition('<https://acme.example/policy> "Title"')).toEqual({
      kind: "url",
      url: "https://acme.example/policy",
    });
  });

  test("doi: prefixed (any case, value trimmed) or bare", () => {
    expect(classifyDefinition("doi:10.1000/xyz123")).toEqual({
      kind: "doi",
      doi: "10.1000/xyz123",
    });
    expect(classifyDefinition("DOI:  10.1000/xyz123 Smith 2020")).toEqual({
      kind: "doi",
      doi: "10.1000/xyz123",
    });
    expect(classifyDefinition("10.1000/xyz123")).toEqual({ kind: "doi", doi: "10.1000/xyz123" });
  });

  test("path: relative, ./, ../, absolute, extension-only; fragment split off", () => {
    expect(classifyDefinition("./docs/pricing.md#refunds")).toEqual({
      kind: "path",
      path: "./docs/pricing.md",
      fragment: "refunds",
    });
    expect(classifyDefinition("../notes/a.md")).toEqual({ kind: "path", path: "../notes/a.md" });
    expect(classifyDefinition("docs/report")).toEqual({ kind: "path", path: "docs/report" });
    expect(classifyDefinition("report.md")).toEqual({ kind: "path", path: "report.md" });
    expect(classifyDefinition("/etc/hosts")).toEqual({ kind: "path", path: "/etc/hosts" });
    expect(classifyDefinition('./a.md "A title"')).toEqual({ kind: "path", path: "./a.md" });
    expect(classifyDefinition("<docs/my report.md>")).toEqual({
      kind: "path",
      path: "docs/my report.md",
    });
    expect(classifyDefinition("./a.md#")).toEqual({ kind: "path", path: "./a.md" });
  });

  test("path: %23 and %25 name a # and a %, so a file name holding # can be cited (I67)", () => {
    expect(classifyDefinition("./a%23b.md")).toEqual({ kind: "path", path: "./a#b.md" });
    expect(classifyDefinition("<./sources/notes %232.md>")).toEqual({
      kind: "path",
      path: "./sources/notes #2.md",
    });
    // One pass: %2523 is a literal %23, never a #.
    expect(classifyDefinition("./a%2523b.md")).toEqual({ kind: "path", path: "./a%23b.md" });
    // Every other % is the file's own character.
    expect(classifyDefinition("./50%.md")).toEqual({ kind: "path", path: "./50%.md" });
    expect(classifyDefinition("./a%20b.md")).toEqual({ kind: "path", path: "./a%20b.md" });
    // A # written plainly still starts the fragment.
    expect(classifyDefinition("./x#y.md")).toEqual({ kind: "path", path: "./x", fragment: "y.md" });
  });

  test("tool, proof: the first word after the prefix", () => {
    expect(classifyDefinition("tool:toolu_01H")).toEqual({ kind: "tool", toolUseId: "toolu_01H" });
    expect(classifyDefinition("Tool: toolu_01H (MoneyAdd)")).toEqual({
      kind: "tool",
      toolUseId: "toolu_01H",
    });
    expect(classifyDefinition("proof:prf_3f9a")).toEqual({ kind: "proof", proofId: "prf_3f9a" });
    expect(classifyDefinition("PROOF: prf_3f9a")).toEqual({ kind: "proof", proofId: "prf_3f9a" });
  });

  test("assume: everything after the prefix", () => {
    expect(classifyDefinition("assume: the fiscal year starts in April")).toEqual({
      kind: "assume",
      text: "the fiscal year starts in April",
    });
  });

  test("text: bibliographic references, bare words, other schemes", () => {
    for (const source of [
      "Smith, J. (2024). Refunds. Acme Press.",
      "README",
      "Wikipedia.",
      "mailto:help@acme.example",
      "ftp://acme.example/file",
      "Note: see the handbook",
      "C:\\docs\\a.md",
    ]) {
      expect(classifyDefinition(source)).toEqual({ kind: "text", text: source });
    }
  });
});

describe("classifyDefinition — ambiguous and malformed inputs", () => {
  test("a bare host is a path, as a Markdown renderer reads it; no scheme is guessed", () => {
    expect(classifyDefinition("arxiv.org/abs/1234")).toEqual({
      kind: "path",
      path: "arxiv.org/abs/1234",
    });
    expect(classifyDefinition("example.com")).toEqual({ kind: "path", path: "example.com" });
  });

  test("a prefix or scheme naming nothing is text", () => {
    for (const source of ["tool:", "proof:   ", "assume:", "doi:", "https://", "https:// x"]) {
      expect(classifyDefinition(source).kind).toBe("text");
    }
  });

  test("a fragment alone points inside the document: text", () => {
    expect(classifyDefinition("#methods")).toEqual({ kind: "text", text: "#methods" });
  });

  test("a prefix is a prefix only at the start, and only these four", () => {
    expect(classifyDefinition("see tool:toolu_1").kind).toBe("text");
    expect(classifyDefinition("toolbox:thing").kind).toBe("text");
    expect(classifyDefinition("proofs/a.md").kind).toBe("path");
  });

  test("a title in any of Markdown's three forms is not part of the destination", () => {
    for (const source of [
      './a.md "Title"',
      "./a.md 'Title'",
      "./a.md (Title)",
      "./a.md  'A  title'  ",
    ]) {
      expect(classifyDefinition(source)).toEqual({ kind: "path", path: "./a.md" });
    }
    // A parenthesis with no space before it is part of the path.
    expect(classifyDefinition("./docs/Foo_(bar).md")).toEqual({
      kind: "path",
      path: "./docs/Foo_(bar).md",
    });
    // Dropping "(2024)" leaves prose, which is still text, reported whole.
    expect(classifyDefinition("Smith, J. (2024)")).toEqual({
      kind: "text",
      text: "Smith, J. (2024)",
    });
  });

  test("a doi: value must have a DOI's shape", () => {
    for (const source of [
      "doi:hello world",
      "doi:../../admin",
      "DOI: 10.1/x",
      "doi:https://doi.org/x",
    ]) {
      expect(classifyDefinition(source)).toEqual({ kind: "text", text: source });
    }
    expect(classifyDefinition("doi: 10.1000/xyz123 (2020)")).toEqual({
      kind: "doi",
      doi: "10.1000/xyz123",
    });
  });

  test("a path with spaces outside angle brackets is prose", () => {
    expect(classifyDefinition("docs/my report.md").kind).toBe("text");
  });

  test("backward compatible: every definition still parses, prefixes are just sources", () => {
    const doc = [
      "Claim one [1]. Claim two [2]. Claim three [A1]. Claim four [3].",
      "",
      "[1]: tool:toolu_01H",
      "[2]: proof:prf_3f9a",
      "[A1]: assume: the fiscal year starts in April",
      "[3]:",
      "  doi:10.1000/xyz123",
    ].join("\n");
    const defs = citationDefinitions(doc);
    expect([...defs.entries()]).toEqual([
      ["1", "tool:toolu_01H"],
      ["2", "proof:prf_3f9a"],
      ["A1", "assume: the fiscal year starts in April"],
      ["3", "doi:10.1000/xyz123"],
    ]);
    expect([...defs.values()].map((s) => classifyDefinition(s).kind)).toEqual([
      "tool",
      "proof",
      "assume",
      "doi",
    ]);
  });
});

describe("isAssumptionMarker", () => {
  test("A and digits only", () => {
    expect(isAssumptionMarker("A1")).toBe(true);
    expect(isAssumptionMarker("A12")).toBe(true);
    expect(isAssumptionMarker("a1")).toBe(false);
    expect(isAssumptionMarker("A")).toBe(false);
    expect(isAssumptionMarker("1")).toBe(false);
    expect(isAssumptionMarker("AB1")).toBe(false);
  });
});

describe("definitionGloss — what a definition line shows past what it names", () => {
  const gloss = (source: string, bibliographic = false) =>
    definitionGloss(source, classifyDefinition(source), bibliographic);

  test("the text after a URL, a DOI, a tool or proof id, or a <destination>", () => {
    expect(gloss("https://acme.example/x Payments clear within 5 days.")).toBe(
      "Payments clear within 5 days.",
    );
    expect(gloss("https://acme.example/x — Acme refunds")).toBe("Acme refunds");
    expect(gloss("doi: 10.1000/xyz Refunds vary.")).toBe("Refunds vary.");
    expect(gloss("tool:toolu_1 The moon is cheese.")).toBe("The moon is cheese.");
    expect(gloss("proof:prf_0123456789abcdef — every room is booked")).toBe("every room is booked");
    expect(gloss("<docs/my report.md> Revenue rose.")).toBe("Revenue rose.");
  });

  test("nothing for a bare destination, a link title, or an assumption", () => {
    expect(gloss("https://acme.example/x")).toBe("");
    expect(gloss('https://acme.example/x "Acme refund policy"')).toBe("");
    expect(gloss("https://acme.example/x 'Acme refund policy'")).toBe("");
    expect(gloss("https://acme.example/x (Acme refund policy)")).toBe("");
    expect(gloss("./docs/pricing.md")).toBe("");
    expect(gloss("tool:toolu_1")).toBe("");
    expect(gloss("assume: the fiscal year starts in April")).toBe("");
  });

  test("free text is all text, unless bibliographic makes it the reference", () => {
    expect(gloss("Smith, J. (2024). Annual report.")).toBe("Smith, J. (2024). Annual report.");
    expect(gloss("Smith, J. (2024). Annual report.", true)).toBe("");
    // A URL's trailing text is prose either way.
    expect(gloss("https://acme.example/x Smith, J. (2024).", true)).toBe("Smith, J. (2024).");
  });
});
