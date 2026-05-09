import { describe, expect, test } from "bun:test";

import { playgroundIndexHtml } from "./render-html";

describe("playgroundIndexHtml (T1)", () => {
  test("emits a complete HTML document", () => {
    const html = playgroundIndexHtml({ studioUrl: "http://localhost:4242" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>CrewHaus Playground</title>");
    expect(html).toContain('id="editor"');
    expect(html).toContain('id="studio"');
    expect(html).toContain("__CREWHAUS_PLAYGROUND__");
  });

  test("escapes the title", () => {
    const html = playgroundIndexHtml({
      title: '<script>alert("pwn")</script>',
      studioUrl: "http://localhost:4242",
    });
    expect(html).toContain("&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("pwn")</script>');
  });

  test("includes templates JSON", () => {
    const html = playgroundIndexHtml({ studioUrl: "http://localhost:4242" });
    expect(html).toContain("cli-coding-agent");
  });

  test("CSP nonce attaches to inline scripts and styles", () => {
    const html = playgroundIndexHtml({
      studioUrl: "http://localhost:4242",
      cspNonce: "n0ncetest",
    });
    expect(html).toContain('<style nonce="n0ncetest">');
    expect(html).toContain('<script nonce="n0ncetest">');
  });
});
