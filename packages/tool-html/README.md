# @crewhaus/tool-html

Reading HTML without reading all of it.

| Tool | Answers |
|---|---|
| `HtmlQuery` | what does this selector find |
| `HtmlTable` | what are the rows of this table |
| `HtmlLinks` | where do this page's links actually go |
| `HtmlForms` | what does this form want |
| `HtmlStructuredData` | what does the page say about itself |
| `HtmlText` | what does it say, without the chrome |
| `HtmlRecords` | give me this repeated block as a table |

A harness that fetched a page and needs one number from it should not put the
page in a context window to find it. Pass the markup, or a path to it, and
get the answer back.

## This is not a browser

Nothing here runs JavaScript, applies CSS, or sees the DOM a page would have
after its scripts ran. It parses the markup it was given, which is what a
fetch returns. For a page that builds itself in the browser the markup will
not contain the content — and these tools will correctly report that it does
not, rather than inventing something.

What it *does* handle is the markup pages actually serve: unclosed `<li>` and
`<td>`, unquoted attributes, `>` inside a quoted attribute value, entities,
stray closing tags, and `<script>` bodies containing things that look like
tags. A parser that only manages well-formed HTML is a parser for documents
nobody serves.

## The selector subset is documented, and enforced

Supported: `tag`, `*`, `#id`, `.class`, `[attr]`, `[attr=v]`, `[attr^=v]`,
`[attr$=v]`, `[attr*=v]`, `[attr~=v]`, descendant, `>`, `+`, `~`, comma
groups, and `:first-child`, `:last-child`, `:nth-child(n)`,
`:nth-of-type(n)`, `:not(simple)`.

Anything else is an **error naming the construct**. A selector engine that
silently ignores the part it does not understand is worse than one that
refuses, because the caller gets elements that merely look right and
concludes the page changed. `:nth-child(2n+1)` is refused rather than read as
`:nth-child(2)` — `parseInt("2n+1")` is 2, so a lenient check would accept
the formula and quietly return the wrong element.

## Details that are wrong by default elsewhere

- **Table spans.** `colspan` and `rowspan` are expanded. A table that uses
  them reads as ragged rows otherwise, and every column after the span is off
  by one — invisible in the output and wrong in every row.
- **Relative links.** Resolved against a base URL, because half a page's
  links are `/thing` and useless on their own. A page's own `<base href>`
  wins, as it would in a browser, and `&amp;` in an href is decoded — a
  follow-up fetch of the undecoded form asks for the wrong thing.
- **Hidden form fields.** Included. A form described without its CSRF token
  is a form that cannot be submitted.
- **Script and style content.** Never part of readable text. An earlier
  version of `HtmlText` returned a page's inline JSON-LD and JavaScript as
  body text, which is both wrong and usually the largest thing on the page.
- **A header row** is one whose cells are *all* `th`, and only if it is
  first. A row mixing `th` and `td` is data with a row label.
- **Broken JSON-LD** is reported as invalid rather than dropped: a page with
  malformed structured data looks identical to one carrying none, and those
  need different action.
- **Empty scrape fields are counted.** A recipe that has quietly stopped
  working returns rows of blanks, which look like data; the count does not.

## What it does not do

- **It does not fetch.** `WebFetch` in `@crewhaus/tool-web` does that, and
  the whole point here is to work on what it returned.
- **It does not click, type, scroll or wait.** Live browser automation needs
  a browser.
- **It does not sanitize HTML** or produce safe markup for rendering.
- **It does not convert to Markdown.**
- **It does not repair a document.** A page whose structure is genuinely
  broken parses to a genuinely odd tree; the recovery rules are a browser's,
  not a validator's.
