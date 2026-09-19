/**
 * The pure half of the package, tested where the behaviour actually lives.
 *
 * A bug in quoted-printable encoding, in the SSRF classifier or in the
 * escaping that keeps a value from becoming markup reads far better as a
 * failing unit than as a failing tool call, so each of those is exercised
 * here directly and `index.test.ts` is left to test the tools.
 */
import { describe, expect, test } from "bun:test";
import {
  buildChatPayload,
  clampToPlatform,
  escapeFor,
  linkSchemeAllowed,
  renderBlocks,
} from "./lib/blocks";
import { buildDigest, digestToBlocks, digestToText } from "./lib/digest";
import {
  addressDomain,
  boundaryFor,
  composeMessage,
  dotStuff,
  encodeBase64Lines,
  encodeHeaderValue,
  encodeQuotedPrintable,
  encodeWords,
  formatDate,
  formatMailbox,
  isValidAddress,
} from "./lib/mime";
import { parseClock, quietDecision, validateSchedule } from "./lib/quiet";
import { rateLimitGate } from "./lib/ratelimit";
import { formatSignatureHeader, hmacHex, signedPayload } from "./lib/sign";
import { renderTemplate, templatePlaceholders } from "./lib/template";
import {
  assertNotSsrf,
  buildNotifyConfig,
  canonicalizeOrigin,
  expandIpv6,
  isPrivateIp,
  normalizeIpv4,
  recipientAllowed,
  redactorFor,
  safeUrlLabel,
} from "./net";

describe("escapeFor", () => {
  test("slack: a channel-wide mention becomes text", () => {
    expect(escapeFor("slack", "<!channel> deploy failed")).toBe("&lt;!channel&gt; deploy failed");
  });

  test("slack: a link construct cannot be forged by a value", () => {
    expect(escapeFor("slack", "<https://evil.test|click me>")).toBe(
      "&lt;https://evil.test|click me&gt;",
    );
  });

  test("slack: ampersands are escaped first, so nothing double-encodes", () => {
    expect(escapeFor("slack", "a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  test("discord: a code fence in a value cannot open one", () => {
    expect(escapeFor("discord", "```rm -rf```")).toBe("\\`\\`\\`rm -rf\\`\\`\\`");
  });

  test("discord: a spoiler and a link construct are neutralised too", () => {
    expect(escapeFor("discord", "||spoiler|| [x](y)")).toBe("\\|\\|spoiler\\|\\| \\[x\\]\\(y\\)");
  });

  test("discord: an ordinary hyphen is left alone, so a branch name stays readable", () => {
    expect(escapeFor("discord", "release-1.2.3")).toBe("release-1.2.3");
  });

  test("teams: HTML and markdown are both neutralised", () => {
    expect(escapeFor("teams", "<b>*x*</b>")).toBe("&lt;b&gt;\\*x\\*&lt;/b&gt;");
  });

  test("a generic webhook receives the value unchanged — JSON is its escaping", () => {
    expect(escapeFor("webhook", "<!channel> & *x*")).toBe("<!channel> & *x*");
  });
});

describe("renderBlocks", () => {
  test("headings, fields and dividers render per platform", () => {
    const { rendered } = renderBlocks("slack", "hello", [
      { kind: "heading", text: "Deploy" },
      { kind: "fields", fields: [{ name: "env", value: "prod" }] },
      { kind: "divider" },
    ]);
    expect(rendered).toBe("hello\n\n*Deploy*\n\n*env:* prod\n\n───");
  });

  test("a link's label is escaped but its URL is not, or the link would break", () => {
    const { rendered } = renderBlocks("slack", undefined, [
      { kind: "link", url: "https://example.test/a?b=c", text: "run > log" },
    ]);
    // The URL survives intact; the label's `>`, which would have closed the
    // construct early and let the rest become markup, does not.
    expect(rendered).toBe("<https://example.test/a?b=c|run &gt; log>");
  });

  test("a javascript: link is dropped and reported, never rendered", () => {
    const { rendered, dropped } = renderBlocks("discord", "see", [
      // biome-ignore lint/suspicious/noExplicitAny: deliberately hostile input
      { kind: "link", url: "javascript:alert(1)" } as any,
    ]);
    expect(rendered).toBe("see");
    expect(dropped.length).toBe(1);
  });

  test("linkSchemeAllowed accepts only http and https", () => {
    expect(linkSchemeAllowed("https://x.test")).toBe(true);
    expect(linkSchemeAllowed("http://x.test")).toBe(true);
    expect(linkSchemeAllowed("data:text/html,<script>")).toBe(false);
    expect(linkSchemeAllowed("not a url")).toBe(false);
  });
});

describe("buildChatPayload", () => {
  test("discord is told to resolve no mentions at all", () => {
    const payload = JSON.parse(buildChatPayload({ platform: "discord", text: "@everyone" }).body);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content).toBe("@everyone");
  });

  test("slack carries the thread reference and disables name linking", () => {
    const payload = JSON.parse(
      buildChatPayload({ platform: "slack", text: "x", threadId: "1.2", channel: "C1" }).body,
    );
    expect(payload).toEqual({ text: "x", link_names: false, channel: "C1", thread_ts: "1.2" });
  });

  test("teams gets a MessageCard, which is what an incoming webhook accepts", () => {
    const payload = JSON.parse(buildChatPayload({ platform: "teams", text: "x" }).body);
    expect(payload["@type"]).toBe("MessageCard");
  });
});

describe("clampToPlatform", () => {
  test("discord's 2000-character limit is enforced with a visible marker", () => {
    const result = clampToPlatform("discord", "x".repeat(3000));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(2000);
    expect(result.text.endsWith("(truncated)")).toBe(true);
  });

  test("a short message is returned untouched", () => {
    expect(clampToPlatform("slack", "hi")).toEqual({ text: "hi", truncated: false });
  });

  test("the cut never splits a surrogate pair", () => {
    const result = clampToPlatform("discord", "🚀".repeat(1500));
    expect(result.text.includes("�")).toBe(false);
    expect([...result.text].every((c) => c === "🚀" || "\n… (truncated)".includes(c))).toBe(true);
  });
});

describe("renderTemplate", () => {
  const templates = {
    deploy: "*{{service}}* deployed to {{env}} by {{actor}}",
  };

  test("values fill the placeholders and the template keeps its own formatting", () => {
    const result = renderTemplate(
      templates.deploy,
      { service: "api", env: "prod", actor: "ci" },
      "slack",
    );
    expect(result).toEqual({
      ok: true,
      text: "*api* deployed to prod by ci",
      used: ["actor", "env", "service"],
      unused: [],
    });
  });

  test("INJECTION: a value carrying Slack markup cannot change the message's structure", () => {
    const result = renderTemplate(
      templates.deploy,
      { service: "<!channel>", env: "prod", actor: "<https://evil.test|click>" },
      "slack",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe(
      "*&lt;!channel&gt;* deployed to prod by &lt;https://evil.test|click&gt;",
    );
    // The literal `<!channel>` never survives, so nothing gets paged.
    expect(result.text.includes("<!channel>")).toBe(false);
  });

  test("INJECTION: a value cannot close a Discord code fence", () => {
    const result = renderTemplate("```\n{{log}}\n```", { log: "```@everyone" }, "discord");
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe("```\n\\`\\`\\`@everyone\n```");
  });

  test("a missing key is an error, not an empty string", () => {
    const result = renderTemplate(templates.deploy, { service: "api" }, "slack");
    expect(result).toEqual({ ok: false, missing: ["actor", "env"] });
  });

  test("null and undefined count as missing rather than rendering the word", () => {
    const result = renderTemplate("{{a}}", { a: null }, "webhook");
    expect(result.ok).toBe(false);
  });

  test("dotted paths read nested data and numbers are written out", () => {
    const result = renderTemplate(
      "{{build.number}} of {{build.total}}",
      { build: { number: 3, total: 10 } },
      "webhook",
    );
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe("3 of 10");
  });

  test("data the template never asks for is reported, not silently ignored", () => {
    const result = renderTemplate("{{a}}", { a: 1, spare: 2 }, "webhook");
    if (!result.ok) throw new Error("unreachable");
    expect(result.unused).toEqual(["spare"]);
  });

  test("templatePlaceholders lists each name once, in first-seen order", () => {
    expect(templatePlaceholders("{{b}} {{a}} {{b}}")).toEqual(["b", "a"]);
  });
});

describe("buildDigest", () => {
  const events = [
    {
      key: "conn-refused",
      summary: "connection refused",
      labels: { host: "a" },
      severity: "error" as const,
    },
    {
      key: "conn-refused",
      summary: "connection refused",
      labels: { host: "b" },
      severity: "critical" as const,
    },
    { key: "conn-refused", labels: { host: "a" } },
    { key: "timeout", summary: "timed out", severity: "warning" as const },
  ];

  test("events fold by key and the repeats are counted", () => {
    const digest = buildDigest(events);
    expect(digest.total).toBe(4);
    expect(digest.distinct).toBe(2);
    expect(digest.groups[0]?.key).toBe("conn-refused");
    expect(digest.groups[0]?.count).toBe(3);
  });

  test("a group takes the most severe occurrence, never the first", () => {
    expect(buildDigest(events).groups[0]?.severity).toBe("critical");
  });

  test("distinct label values are listed and sorted", () => {
    expect(buildDigest(events).groups[0]?.labels["host"]).toEqual(["a", "b"]);
  });

  test("the cap limits what is rendered, never what is counted", () => {
    const digest = buildDigest(events, { maxGroups: 1 });
    expect(digest.groups.length).toBe(1);
    expect(digest.total).toBe(4);
    expect(digest.omittedGroups).toBe(1);
    expect(digest.omittedEvents).toBe(1);
  });

  test("ties break on key, so the same events always fold to the same bytes", () => {
    const a = buildDigest([{ key: "b" }, { key: "a" }]);
    const b = buildDigest([{ key: "a" }, { key: "b" }]);
    expect(a.groups.map((g) => g.key)).toEqual(["a", "b"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("the text rendering says how many were left out", () => {
    const text = digestToText(buildDigest(events, { maxGroups: 1 }), "Overnight");
    expect(
      text.startsWith("Overnight\n4 events in 2 groups\n3× connection refused [critical]"),
    ).toBe(true);
    expect(text.includes("1 more groups covering 1 events")).toBe(true);
  });

  test("the block rendering is a list ChatPost can take straight", () => {
    const blocks = digestToBlocks(buildDigest(events), "Overnight");
    expect(blocks[0]).toEqual({ kind: "heading", text: "Overnight" });
    expect(blocks.some((b) => b.kind === "fields")).toBe(true);
  });
});

describe("quiet hours", () => {
  const nightly = {
    timezone: "Europe/Berlin",
    quietWindows: [{ start: "22:00", end: "07:00" }],
  };

  test("parseClock accepts HH:MM and 24:00, and refuses nonsense", () => {
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("24:00")).toBe(1440);
    expect(parseClock("24:01")).toBeNull();
    expect(parseClock("7:5")).toBeNull();
  });

  test("a window that wraps past midnight blocks the small hours", () => {
    // 01:00 Berlin on a winter night.
    const decision = quietDecision(nightly, Date.parse("2026-01-15T00:00:00Z"));
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.allowed).toBe(false);
    expect(decision.localTime).toBe("01:00");
    expect(decision.nextAllowed).toBe("2026-01-15T06:00:00.000Z"); // 07:00 CET
  });

  test("outside the window it says so and offers no next time", () => {
    const decision = quietDecision(nightly, Date.parse("2026-01-15T11:00:00Z"));
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.allowed).toBe(true);
    expect(decision.nextAllowed).toBeUndefined();
  });

  test("a weekday filter applies to the day the window starts on", () => {
    const weekend = {
      timezone: "UTC",
      quietWindows: [{ days: ["sat" as const], start: "20:00", end: "04:00" }],
    };
    // Sunday 02:00 UTC is inside the window that started on Saturday.
    const sunday = quietDecision(weekend, Date.parse("2026-01-18T02:00:00Z"));
    if ("error" in sunday) throw new Error(sunday.error);
    expect(sunday.allowed).toBe(false);
    expect(sunday.localWeekday).toBe("sun");
    // Sunday 21:00 is not, because the window only starts on Saturdays.
    const later = quietDecision(weekend, Date.parse("2026-01-18T21:00:00Z"));
    if ("error" in later) throw new Error(later.error);
    expect(later.allowed).toBe(true);
  });

  test("DST is real: the spring-forward night ends when the local clock says 07:00", () => {
    const usNight = {
      timezone: "America/New_York",
      quietWindows: [{ start: "22:00", end: "07:00" }],
    };
    // 07:00Z on 2026-03-08 is the instant the US clocks jump 02:00 → 03:00.
    const decision = quietDecision(usNight, Date.parse("2026-03-08T07:00:00Z"));
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.allowed).toBe(false);
    expect(decision.localTime).toBe("03:00");
    expect(decision.nextAllowed).toBe("2026-03-08T11:00:00.000Z"); // 07:00 EDT
  });

  test("a blackout date is quiet all day and releases at local midnight", () => {
    const schedule = { timezone: "UTC", quietWindows: [], blackoutDates: ["2026-12-25"] };
    const decision = quietDecision(schedule, Date.parse("2026-12-25T13:00:00Z"));
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.allowed).toBe(false);
    expect(decision.nextAllowed).toBe("2026-12-26T00:00:00.000Z");
  });

  test("nothing reads the clock — the same instant always gives the same answer", () => {
    const a = quietDecision(nightly, Date.parse("2026-01-15T00:00:00Z"));
    const b = quietDecision(nightly, Date.parse("2026-01-15T00:00:00Z"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("an unknown timezone is an error rather than a silent UTC fallback", () => {
    const decision = quietDecision(
      { timezone: "Mars/Olympus", quietWindows: [{ start: "1:00", end: "2:00" }] },
      0,
    );
    expect("error" in decision).toBe(true);
  });

  test("validateSchedule refuses an empty window and a schedule that blocks nothing", () => {
    expect(validateSchedule({ timezone: "UTC", quietWindows: [] })).toContain("never block");
    expect(
      validateSchedule({ timezone: "UTC", quietWindows: [{ start: "09:00", end: "09:00" }] }),
    ).toContain("empty");
  });
});

describe("rateLimitGate", () => {
  const now = Date.parse("2026-09-17T09:00:00Z");

  test("the first send for a key is allowed and recorded", () => {
    const decision = rateLimitGate({ key: "disk-full", nowMs: now, windowMs: 3_600_000 });
    expect(decision.allowed).toBe(true);
    expect(decision.nextState["disk-full"]).toEqual({ windowStart: now, count: 1, last: now });
  });

  test("a second send inside the window is refused, with when it may retry", () => {
    const first = rateLimitGate({ key: "k", nowMs: now, windowMs: 3_600_000 });
    const second = rateLimitGate({
      key: "k",
      nowMs: now + 60_000,
      windowMs: 3_600_000,
      state: first.nextState,
    });
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBe(3_540_000);
    expect(second.retryAt).toBe("2026-09-17T10:00:00.000Z");
    // A refusal must not advance the state, or the window would never end.
    expect(second.nextState).toEqual(first.nextState);
  });

  test("the window expires and the key is allowed again", () => {
    const first = rateLimitGate({ key: "k", nowMs: now, windowMs: 1000 });
    const later = rateLimitGate({
      key: "k",
      nowMs: now + 1001,
      windowMs: 1000,
      state: first.nextState,
    });
    expect(later.allowed).toBe(true);
    expect(later.count).toBe(1);
  });

  test("a limit above one allows that many and then stops", () => {
    let state = {};
    const results = [0, 1, 2, 3].map((i) => {
      const decision = rateLimitGate({
        key: "k",
        nowMs: now + i,
        windowMs: 10_000,
        limit: 3,
        state,
      });
      state = decision.nextState;
      return decision.allowed;
    });
    expect(results).toEqual([true, true, true, false]);
  });

  test('"peek" answers without recording', () => {
    const decision = rateLimitGate({ key: "k", nowMs: now, windowMs: 1000, mode: "peek" });
    expect(decision.allowed).toBe(true);
    expect(decision.nextState).toEqual({});
  });

  test("long-expired keys are pruned, so the persisted record cannot grow forever", () => {
    const stale = { old: { windowStart: now - 10_000, count: 1, last: now - 10_000 } };
    const decision = rateLimitGate({ key: "new", nowMs: now, windowMs: 1000, state: stale });
    expect(decision.pruned).toEqual(["old"]);
    expect(Object.keys(decision.nextState)).toEqual(["new"]);
  });
});

/** A minimal RFC 2045 decoder, so the encoder is checked by round-trip. */
function decodeQuotedPrintable(encoded: string): string {
  const unfolded = encoded.split("=\r\n").join("");
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const char = unfolded[i] as string;
    if (char === "=" && i + 2 < unfolded.length) {
      bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
  }
  return Buffer.from(Uint8Array.from(bytes)).toString("utf8");
}

describe("quoted-printable", () => {
  test("printable ASCII passes through and = is encoded", () => {
    expect(encodeQuotedPrintable("a=b")).toBe("a=3Db");
  });

  test("UTF-8 becomes byte escapes", () => {
    expect(encodeQuotedPrintable("café")).toBe("caf=C3=A9");
  });

  test("trailing whitespace before a hard break is encoded, so a relay cannot eat it", () => {
    expect(encodeQuotedPrintable("a \nb")).toBe("a=20\r\nb");
  });

  test("a leading dot is encoded, so no amount of SMTP dot handling can eat it", () => {
    expect(encodeQuotedPrintable(".hidden")).toBe("=2Ehidden");
  });

  test("a long line is soft-broken and no line exceeds 76 characters", () => {
    const encoded = encodeQuotedPrintable("x".repeat(500));
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded.includes("=\r\n")).toBe(true);
    // Removing the soft breaks gives the original back.
    expect(encoded.split("=\r\n").join("")).toBe("x".repeat(500));
  });

  test("a soft break never splits an =XX triplet — the text decodes back exactly", () => {
    const source = `${"é".repeat(200)}\nplain ASCII line\n${"=".repeat(90)}`;
    const encoded = encodeQuotedPrintable(source);
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeQuotedPrintable(encoded)).toBe(source.replace(/\n/g, "\r\n"));
  });

  test("CRLF, CR and LF all normalise to one hard break", () => {
    expect(encodeQuotedPrintable("a\r\nb\rc\nd")).toBe("a\r\nb\r\nc\r\nd");
  });
});

describe("header encoding", () => {
  test("plain ASCII is left alone", () => {
    expect(encodeHeaderValue("Deploy finished")).toBe("Deploy finished");
  });

  test("INJECTION: a newline in a subject is encoded, so it cannot add a header", () => {
    const encoded = encodeHeaderValue("ok\r\nBcc: attacker@evil.test");
    expect(encoded.includes("\r")).toBe(false);
    expect(encoded.includes("\n")).toBe(false);
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8")).toBe(
      "ok\r\nBcc: attacker@evil.test",
    );
  });

  test("a long non-ASCII value becomes several encoded words, each within 75 characters", () => {
    for (const word of encodeWords("ü".repeat(200)).split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word.startsWith("=?UTF-8?B?")).toBe(true);
    }
  });

  test("an encoded word never splits a multi-byte character", () => {
    const words = encodeWords("𝄞".repeat(40)).split(" ");
    for (const word of words) {
      const decoded = Buffer.from(word.slice(10, -2), "base64").toString("utf8");
      expect(decoded.includes("�")).toBe(false);
    }
  });

  test("a display name with a comma is quoted, so it stays one address", () => {
    expect(formatMailbox({ address: "b@x.test", name: 'Smith, "Bob"' })).toBe(
      '"Smith, \\"Bob\\"" <b@x.test>',
    );
  });

  test("a non-ASCII display name is encoded rather than quoted", () => {
    expect(formatMailbox({ address: "b@x.test", name: "Björn" })).toContain("=?UTF-8?B?");
  });

  test("the date is formatted without a locale", () => {
    expect(formatDate(new Date("2026-09-17T09:30:05Z"))).toBe("Thu, 17 Sep 2026 09:30:05 +0000");
  });
});

describe("addresses", () => {
  test("ordinary addresses are accepted", () => {
    expect(isValidAddress("ops@example.com")).toBe(true);
    expect(isValidAddress("first.last+tag@sub.example.co.uk")).toBe(true);
  });

  test("anything carrying a newline, comma, space or angle bracket is refused", () => {
    for (const bad of [
      "a\r\nBcc: b@x.test",
      "a,b@x.test",
      "a b@x.test",
      "<a@x.test>",
      "a@x",
      "@x.test",
      "a@",
    ]) {
      expect({ bad, ok: isValidAddress(bad) }).toEqual({ bad, ok: false });
    }
  });

  test("addressDomain lowercases and handles the missing case", () => {
    expect(addressDomain("A@Example.COM")).toBe("example.com");
    expect(addressDomain("nope")).toBeNull();
  });
});

describe("composeMessage", () => {
  const base = {
    from: { address: "ci@example.com", name: "CI" },
    to: [{ address: "ops@example.com" }],
    subject: "Nightly run",
    text: "All green.\n",
    date: new Date("2026-09-17T09:30:00Z"),
  };

  test("a plain message carries the headers a client needs", () => {
    const result = composeMessage(base);
    if (!result.ok) throw new Error(result.error);
    expect(result.message).toContain("MIME-Version: 1.0\r\n");
    expect(result.message).toContain("Date: Thu, 17 Sep 2026 09:30:00 +0000\r\n");
    expect(result.message).toContain("From: CI <ci@example.com>\r\n");
    expect(result.message).toContain("To: <ops@example.com>\r\n");
    expect(result.message).toContain("Subject: Nightly run\r\n");
    expect(result.message).toContain('Content-Type: text/plain; charset="utf-8"\r\n');
    expect(result.message).toContain("Content-Transfer-Encoding: quoted-printable\r\n");
    expect(result.message).toContain("\r\n\r\nAll green.");
  });

  test("the Message-ID is derived from the message, so the same message has the same id", () => {
    const a = composeMessage(base);
    const b = composeMessage(base);
    if (!a.ok || !b.ok) throw new Error("compose failed");
    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId.endsWith("@example.com>")).toBe(true);
    expect(a.message).toBe(b.message);
  });

  test("BCC reaches the envelope and never a header", () => {
    const result = composeMessage({ ...base, bcc: [{ address: "audit@example.com" }] });
    if (!result.ok) throw new Error(result.error);
    expect(result.message.toLowerCase()).not.toContain("bcc:");
    expect(result.message).not.toContain("audit@example.com");
    expect(result.envelopeTo).toEqual(["audit@example.com", "ops@example.com"]);
  });

  test("text plus HTML becomes multipart/alternative, text first", () => {
    const result = composeMessage({ ...base, html: "<p>All green.</p>" });
    if (!result.ok) throw new Error(result.error);
    expect(result.message).toContain("Content-Type: multipart/alternative; boundary=");
    expect(result.message.indexOf("text/plain")).toBeLessThan(result.message.indexOf("text/html"));
  });

  test("an attachment wraps the body in multipart/mixed and is base64", () => {
    const result = composeMessage({
      ...base,
      attachments: [
        {
          filename: "report.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("hi"),
        },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.message).toContain("Content-Type: multipart/mixed; boundary=");
    expect(result.message).toContain('Content-Disposition: attachment; filename="report.txt"');
    expect(result.message).toContain("Content-Transfer-Encoding: base64");
    expect(result.message).toContain(Buffer.from("hi").toString("base64"));
  });

  test("a non-ASCII filename becomes an RFC 2231 parameter", () => {
    const result = composeMessage({
      ...base,
      attachments: [
        {
          filename: "bericht-für-sie.txt",
          contentType: "text/plain",
          content: new Uint8Array([1]),
        },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.message).toContain("filename*=UTF-8''bericht-f%C3%BCr-sie.txt");
  });

  test("INJECTION: a subject carrying CRLF cannot add a header", () => {
    const result = composeMessage({ ...base, subject: "hi\r\nBcc: attacker@evil.test" });
    if (!result.ok) throw new Error(result.error);
    expect(result.message.toLowerCase()).not.toContain("bcc: attacker");
    const headerBlock = result.message.split("\r\n\r\n")[0] as string;
    expect(headerBlock.split("\r\n").filter((l) => /^[A-Za-z]/.test(l)).length).toBeLessThan(10);
  });

  test("INJECTION: a recipient address carrying CRLF is refused outright", () => {
    const result = composeMessage({
      ...base,
      to: [{ address: "a@x.test\r\nRCPT TO:<b@evil.test>" }],
    });
    expect(result.ok).toBe(false);
  });

  test("INJECTION: an In-Reply-To carrying CRLF is refused, not folded into a header", () => {
    const result = composeMessage({
      ...base,
      inReplyTo: "<real@x.test>\r\nBcc: attacker@evil.test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("inReplyTo");
    // And the legitimate form still composes, so the check is a gate and not a ban.
    const good = composeMessage({ ...base, inReplyTo: "<real@x.test>" });
    if (!good.ok) throw new Error(good.error);
    expect(good.message).toContain("In-Reply-To: <real@x.test>");
  });

  test("INJECTION: a References entry carrying CRLF is refused", () => {
    const result = composeMessage({
      ...base,
      references: ["<a@x.test>", "<b@x.test>\r\nX-Evil: yes"],
    });
    expect(result.ok).toBe(false);
    const good = composeMessage({ ...base, references: ["<a@x.test>", "<b@x.test>"] });
    if (!good.ok) throw new Error(good.error);
    expect(good.message).toContain("References: <a@x.test> <b@x.test>");
  });

  test("INJECTION: a contentId carrying CRLF cannot add a header inside a MIME part", () => {
    const attachment = {
      filename: "logo.png",
      contentType: "image/png",
      content: new Uint8Array([1, 2, 3]),
      contentId: "logo@crewhaus\r\nX-Evil: yes",
    };
    const result = composeMessage({ ...base, attachments: [attachment] });
    expect(result.ok).toBe(false);
    const good = composeMessage({
      ...base,
      attachments: [{ ...attachment, contentId: "logo@crewhaus" }],
    });
    if (!good.ok) throw new Error(good.error);
    expect(good.message).toContain("Content-ID: <logo@crewhaus>");
    expect(good.message).not.toContain("X-Evil");
  });

  test("a header with nothing to fold at is refused rather than sent over the line limit", () => {
    const result = composeMessage({ ...base, headers: { "X-Trace": "x".repeat(1200) } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("998");
    // The same length with somewhere to fold is fine, and every physical
    // line comes back inside the limit.
    const foldable = composeMessage({
      ...base,
      headers: { "X-Trace": Array.from({ length: 120 }, () => "token").join(" ") },
    });
    if (!foldable.ok) throw new Error(foldable.error);
    for (const line of foldable.message.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(998);
    }
  });

  test("no assembled header line carries a bare CR or LF, whatever the input", () => {
    const result = composeMessage({
      ...base,
      from: { address: "ci@example.com", name: "Line\r\nBreak" },
      subject: "one\r\ntwo",
      headers: { "X-Note": "three\r\nfour" },
    });
    if (!result.ok) throw new Error(result.error);
    const headerBlock = result.message.split("\r\n\r\n")[0] as string;
    for (const line of headerBlock.split("\r\n")) {
      // Every line is either a new header or a fold, and a fold starts with
      // whitespace. A raw break would show up as a line that is neither.
      expect(/^(?:[A-Za-z][A-Za-z0-9-]*:|[ \t])/.test(line)).toBe(true);
    }
  });

  test("a header this builder owns cannot be overridden", () => {
    const result = composeMessage({ ...base, headers: { "Message-ID": "<forged@x.test>" } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("cannot be overridden");
  });

  test("a message with no recipients is refused", () => {
    expect(composeMessage({ ...base, to: [] }).ok).toBe(false);
  });

  test("a long recipient list folds between addresses, never inside one", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      address: `person${i}@example.com`,
      name: `Person, Number ${i}`,
    }));
    const result = composeMessage({ ...base, to: many });
    if (!result.ok) throw new Error(result.error);
    for (const line of result.message.split("\r\n")) {
      // No folded line may leave an unbalanced quote behind.
      expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });

  test("boundaries are content-derived, and differ between the two nestings", () => {
    expect(boundaryFor("alt", "x")).toBe(boundaryFor("alt", "x"));
    expect(boundaryFor("alt", "x")).not.toBe(boundaryFor("mixed", "x"));
  });

  test("base64 output wraps at 76 columns", () => {
    for (const line of encodeBase64Lines(new Uint8Array(500)).split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

describe("dotStuff", () => {
  test("a line that begins with a dot is doubled, so it cannot end DATA", () => {
    expect(dotStuff("a\n.\nb")).toBe("a\r\n..\r\nb\r\n.\r\n");
  });

  test("the terminator is always the final CRLF.CRLF", () => {
    expect(dotStuff("hello").endsWith("\r\n.\r\n")).toBe(true);
  });
});

describe("webhook signing", () => {
  test("the body scheme signs the body alone", () => {
    expect(signedPayload("body", "{}")).toBe("{}");
    expect(formatSignatureHeader("body", "abc", "sha256")).toBe("sha256=abc");
  });

  test("the timestamped scheme signs <seconds>.<body> and says so in the header", () => {
    expect(signedPayload("timestamped", "{}", 1700)).toBe("1700.{}");
    expect(formatSignatureHeader("timestamped", "abc", "sha256", 1700)).toBe("t=1700,v1=abc");
  });

  test("the timestamped scheme refuses to sign without a timestamp", () => {
    expect(() => signedPayload("timestamped", "{}")).toThrow();
  });

  test("the HMAC is the well-known value for a known key and message", () => {
    expect(hmacHex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });
});

describe("the outbound gate's pure half", () => {
  test("IPv4 in octal, hex and integer form all classify as loopback", () => {
    for (const spelling of ["127.0.0.1", "0177.0.0.1", "0x7f000001", "2130706433", "127.1"]) {
      expect({ spelling, private: isPrivateIp(spelling) }).toEqual({ spelling, private: true });
    }
  });

  test("the cloud metadata address and the RFC1918 ranges are refused", () => {
    for (const ip of ["169.254.169.254", "10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1"]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true });
    }
  });

  test("a public address is not refused", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  test("every spelling of IPv6 loopback classifies the same", () => {
    for (const spelling of ["::1", "0:0:0:0:0:0:0:1", "::0:1", "[::1]"]) {
      expect({ spelling, private: isPrivateIp(spelling) }).toEqual({ spelling, private: true });
    }
  });

  test("an IPv6 range carrying an IPv4 address is judged by the address it carries", () => {
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIp("2002:a9fe:a9fe::")).toBe(true); // 6to4 over 169.254.169.254
    expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true); // NAT64 over 127.0.0.1
  });

  test("an IPv6-shaped string that cannot be parsed is refused, not waved through", async () => {
    // `isPrivateIp` answers "is this address inside a private range", and it
    // is handed hostnames as well as literals, so a string it cannot parse is
    // not private — it is not an address at all. The refusal that matters
    // lives in the gate, which will not hand back an unparseable IPv6 host as
    // a pinned target.
    expect(expandIpv6("::gggg")).toBeNull();
    await expect(assertNotSsrf("::gggg")).rejects.toThrow(/not a valid IPv6 address/);
    await expect(assertNotSsrf("[::gggg]")).rejects.toThrow(/not a valid IPv6 address/);
  });

  test("every spelling in the SSRF audit matrix is classified private", () => {
    // The 2026-09-18 audit of this classifier across the repo: each row is a
    // way of writing an address that must never be dialled. Three of them —
    // both `64:ff9b:1::/48` NAT64 spellings and the translated
    // `::ffff:0:0:0/96` form — leaked before the classifier was replaced with
    // the synchronised block, so this matrix is the regression guard.
    const mustBePrivate = [
      "169.254.169.254",
      "2852039166",
      "0xA9FEA9FE",
      "0251.0376.0251.0376",
      "127.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::169.254.169.254",
      "64:ff9b:1::a9fe:a9fe",
      "64:ff9b:1:0:0:0:a9fe:a9fe",
      "::a9fe:a9fe",
      "::ffff:0:a9fe:a9fe",
      "2002:a9fe:a9fe::",
      "127.0.0.1",
      "::1",
      "0:0:0:0:0:0:0:1",
      "64:ff9b::7f00:1",
      "fe80::1",
      "febf::1",
      "fd00::1",
      "::",
      "0:0:0:0:0:0:0:0",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "0.0.0.0",
    ];
    const leaked = mustBePrivate.filter((spelling) => !isPrivateIp(spelling));
    expect(leaked).toEqual([]);
  });

  test("the audit matrix does not over-block a real public address", () => {
    // The other half of the property: a classifier that refuses everything
    // passes the matrix above and breaks every real send.
    const mustStayPublic = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ];
    const overBlocked = mustStayPublic.filter((spelling) => isPrivateIp(spelling));
    expect(overBlocked).toEqual([]);
  });

  test("a link-local address is refused whatever its zone id says", () => {
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
  });

  test("normalizeIpv4 rejects an over-long or non-numeric spelling", () => {
    expect(normalizeIpv4("1.2.3.4.5")).toBeNull();
    expect(normalizeIpv4("1.2.3.999")).toBeNull();
    expect(normalizeIpv4("example.com")).toBeNull();
  });

  test("origins canonicalise: case, default ports and paths all fall away", () => {
    expect(canonicalizeOrigin("HTTPS://Example.COM:443/ignored?q=1")).toBe("https://example.com");
    expect(canonicalizeOrigin("http://example.com:8080")).toBe("http://example.com:8080");
  });

  test("a non-http scheme is refused as an origin", () => {
    expect(() => canonicalizeOrigin("ftp://example.com")).toThrow();
  });

  test("a URL label never prints the path, because a webhook path is a credential", () => {
    const label = safeUrlLabel("https://hooks.example.test/services/T1/B2/secrettoken?x=1");
    expect(label).not.toContain("secrettoken");
    expect(label).not.toContain("/services/");
    expect(label).toContain("https://hooks.example.test");
  });

  test("recipients match exactly or by *@domain, and an empty list refuses everyone", () => {
    const cfg = buildNotifyConfig({ allowed_recipients: ["ops@example.com", "*@team.test"] });
    expect(recipientAllowed("ops@example.com", cfg)).toBe(true);
    expect(recipientAllowed("OPS@Example.com", cfg)).toBe(true);
    expect(recipientAllowed("anyone@team.test", cfg)).toBe(true);
    expect(recipientAllowed("other@example.com", cfg)).toBe(false);
    expect(recipientAllowed("ops@example.com", buildNotifyConfig({}))).toBe(false);
  });

  test("a bare domain is NOT a wildcard, because it would read as one and not act as one", () => {
    const cfg = buildNotifyConfig({ allowed_recipients: ["example.com"] });
    expect(recipientAllowed("anyone@example.com", cfg)).toBe(false);
  });

  test("the redactor removes a secret in its literal, url-encoded and base64 forms", () => {
    const redact = redactorFor(["sup3r-s3cret-value"]);
    expect(redact("token=sup3r-s3cret-value")).toBe("token=<redacted>");
    expect(redact(encodeURIComponent("sup3r-s3cret-value"))).toBe("<redacted>");
    expect(redact(Buffer.from("sup3r-s3cret-value").toString("base64"))).toBe("<redacted>");
  });

  test("a very short secret is left alone rather than mangling every result", () => {
    expect(redactorFor(["ab"])("a cab")).toBe("a cab");
    expect(redactorFor([undefined])("anything")).toBe("anything");
  });
});
