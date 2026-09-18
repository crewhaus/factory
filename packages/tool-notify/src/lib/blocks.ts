/**
 * Message structure, and the escaping that keeps a value from becoming it.
 *
 * A notification is almost always assembled from data the harness did not
 * write: a branch name, an error string, a customer's subject line. If that
 * data reaches a chat platform unescaped it stops being a value and becomes
 * syntax — `<!channel>` on Slack pages everyone in the room, `@everyone` on
 * Discord does the same, and a stray ``` turns the rest of the message into
 * a code block. That is markup injection, and it is the reason this file
 * exists separately from the tools: escaping is a pure function that can be
 * tested exhaustively, and every path that puts text on a platform goes
 * through it.
 *
 * The blocks are deliberately few. Five kinds cover a notification — a
 * heading, a paragraph, a list of name/value fields, a rule, a link — and
 * each renders to something every platform actually supports. A richer model
 * would render well on one platform and badly on the others, which is worse
 * than a plain one that renders the same everywhere.
 */

export type Platform = "slack" | "discord" | "teams" | "webhook";

export type Block =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | {
      readonly kind: "fields";
      readonly fields: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }
  | { readonly kind: "divider" }
  | { readonly kind: "link"; readonly url: string; readonly text?: string };

/**
 * Escape a VALUE for a platform, so it can only ever be read as text.
 *
 *  - **slack**: `&`, `<` and `>` are the only three characters Slack treats
 *    as markup structure, and escaping them is exactly what Slack's own docs
 *    prescribe. It kills `<!channel>`, `<!here>`, `<@U123>` and the
 *    `<url|label>` link form in one move. Slack's `*bold*`/`_italic_` marks
 *    are cosmetic — they cannot change who is notified or where a link goes
 *    — so they are left alone rather than backslash-littering every message.
 *  - **discord**: backslash-escape the characters that open markdown
 *    constructs, so a value cannot close a code fence or start a spoiler.
 *    Mentions are NOT handled here: Discord has no in-content escape for
 *    them, and the correct fix is the `allowed_mentions` field on the
 *    request, which `buildChatPayload` always sets to "parse nothing".
 *  - **teams**: HTML-escape first, because Teams renders a card's text as
 *    HTML, then backslash-escape the markdown marks it also honours.
 *  - **webhook**: identity. A generic webhook receives JSON; JSON encoding
 *    is the escaping, and mangling the value on the way would corrupt a
 *    payload nobody asked to be rendered.
 */
export function escapeFor(platform: Platform, value: string): string {
  switch (platform) {
    case "slack":
      return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    case "discord":
      // Only the marks that introduce STRUCTURE: code fences, emphasis,
      // spoilers, block quotes and links. `#`, `-` and `1.` make a heading or
      // a list at the start of a line and cannot change what the message
      // does, so they are left alone rather than littering every hyphen in
      // every branch name with a backslash.
      return value.replace(/([\\`*_~|>[\]()])/g, "\\$1");
    case "teams":
      return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/([\\`*_~\[\]])/g, "\\$1");
    case "webhook":
      return value;
  }
}

/**
 * Is a URL safe to put behind a link?
 *
 * `javascript:`, `data:` and `vbscript:` in a chat message are a phishing
 * payload aimed at whoever clicks. Only http and https get rendered as
 * links; anything else is refused rather than silently downgraded, because a
 * caller who asked for a link and got plain text would not notice.
 */
export function linkSchemeAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Render one block for a platform. Values are escaped; structure is not. */
function renderBlock(platform: Platform, block: Block): string {
  switch (block.kind) {
    case "heading": {
      const text = escapeFor(platform, block.text);
      if (platform === "slack") return `*${text}*`;
      if (platform === "webhook") return block.text;
      return `**${text}**`;
    }
    case "paragraph":
      return escapeFor(platform, block.text);
    case "fields": {
      const lines = block.fields.map((f) => {
        const name = escapeFor(platform, f.name);
        const value = escapeFor(platform, f.value);
        if (platform === "slack") return `*${name}:* ${value}`;
        if (platform === "webhook") return `${f.name}: ${f.value}`;
        return `**${name}:** ${value}`;
      });
      return lines.join("\n");
    }
    case "divider":
      return platform === "slack" ? "───" : "---";
    case "link": {
      const label = block.text ?? block.url;
      if (platform === "slack") {
        // The URL goes inside Slack's own link syntax unescaped — escaping it
        // would break the link — but the LABEL is escaped, because a label
        // containing `|` or `>` would otherwise close the construct early and
        // let the rest of the label become markup.
        return `<${block.url}|${escapeFor("slack", label)}>`;
      }
      if (platform === "webhook") return `${label}: ${block.url}`;
      return `[${escapeFor(platform, label)}](${block.url})`;
    }
  }
}

/**
 * Render a text body plus blocks into one string for a platform.
 *
 * Blocks with an unusable link are dropped and reported rather than
 * rendered, so a `javascript:` URL never reaches a reader.
 */
export function renderBlocks(
  platform: Platform,
  text: string | undefined,
  blocks: readonly Block[],
): { readonly rendered: string; readonly dropped: readonly string[] } {
  const dropped: string[] = [];
  const parts: string[] = [];
  if (text !== undefined && text !== "") parts.push(escapeFor(platform, text));
  for (const block of blocks) {
    if (block.kind === "link" && !linkSchemeAllowed(block.url)) {
      dropped.push("a link block whose URL was not http(s)");
      continue;
    }
    parts.push(renderBlock(platform, block));
  }
  return { rendered: parts.join("\n\n"), dropped };
}

/** Platform byte/character limits, so a message is cut here rather than there. */
export const PLATFORM_TEXT_LIMIT: Readonly<Record<Platform, number>> = {
  slack: 40_000,
  discord: 2_000,
  teams: 28_000,
  webhook: 100_000,
};

/**
 * Cut `text` to a platform's limit, marking the cut. Counting is in UTF-16
 * code units, which is what every one of these platforms documents its limit
 * in, and the cut never splits a surrogate pair.
 */
export function clampToPlatform(
  platform: Platform,
  text: string,
): { readonly text: string; readonly truncated: boolean } {
  const limit = PLATFORM_TEXT_LIMIT[platform];
  if (text.length <= limit) return { text, truncated: false };
  const marker = "\n… (truncated)";
  let cut = limit - marker.length;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // do not split a surrogate pair
  return { text: `${text.slice(0, cut)}${marker}`, truncated: true };
}

export type ChatPayload = {
  readonly body: string;
  readonly contentType: string;
};

/**
 * The JSON body a platform's incoming-webhook or API endpoint expects.
 *
 * Slack and Discord both accept a thread reference, and both are told not to
 * resolve mentions: Slack via `link_names: false` plus the escaping above,
 * Discord via `allowed_mentions: { parse: [] }`, which is the only reliable
 * way to stop `@everyone` in a message body from paging a server.
 */
export function buildChatPayload(input: {
  readonly platform: Platform;
  readonly text: string;
  readonly threadId?: string | undefined;
  readonly channel?: string | undefined;
  readonly username?: string | undefined;
}): ChatPayload {
  const { platform, text } = input;
  if (platform === "slack") {
    return {
      body: JSON.stringify({
        text,
        link_names: false,
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.threadId !== undefined ? { thread_ts: input.threadId } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
      }),
      contentType: "application/json",
    };
  }
  if (platform === "discord") {
    return {
      body: JSON.stringify({
        content: text,
        allowed_mentions: { parse: [] },
        ...(input.username !== undefined ? { username: input.username } : {}),
      }),
      contentType: "application/json",
    };
  }
  if (platform === "teams") {
    return {
      body: JSON.stringify({
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        text,
      }),
      contentType: "application/json",
    };
  }
  return {
    body: JSON.stringify({
      text,
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    }),
    contentType: "application/json",
  };
}

/** Platforms whose posted messages can be edited or deleted by id. */
export const EDITABLE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["slack", "discord"]);

/** Platforms that carry a thread identifier on a post. */
export const THREADED_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["slack", "discord"]);
