# @crewhaus/tool-docs

Deterministic document tools. Word, Excel and PowerPoint packages, PDFs, mail,
mbox archives, calendars and contacts — read, written and compared without a
model call and without a dependency.

Every format reader here is hand-written against the published specification,
and each one states the exact subset it supports. Where something cannot be
read faithfully — an encrypted PDF, a scan with no text layer, a CJK font with
no `/ToUnicode` map — the tool says so. A confidently wrong answer about what a
contract says is worse than no answer.

```yaml
tools:
  - all-docs        # every tool below
  - -pdfMerge       # ...except this one
```

| Tool | What it does |
|---|---|
| `DocumentText` | Plain text from any supported file, dispatching on what it actually is |
| `DocumentDiff` | Compare two documents' text, across formats, with a unified diff |
| `DocxRead` | A .docx to paragraphs with styles and heading levels, lists, tables, properties |
| `DocxWrite` | Headings, paragraphs, lists and tables to a minimal valid .docx |
| `EmlParse` | An RFC 5322 message to headers, addresses, body parts and attachment metadata |
| `IcsParse` | An RFC 5545 calendar to events, attendees, recurrence rules and alarms |
| `IcsWrite` | Events to a .ics file, folded and escaped as the RFC requires |
| `MboxSplit` | An mbox to a listing of its messages, with one extractable by index |
| `PdfInfo` | Page count, page sizes, metadata, encryption, and which pages carry text |
| `PdfMerge` | Several PDFs, or selected pages of them, concatenated into one |
| `PdfSplit` | A page range written out as a new PDF |
| `PdfText` | A PDF's text, with line and word breaks reconstructed from glyph positions |
| `PptxRead` | A deck to slide titles and shape text, in presentation order |
| `VcardParse` | An RFC 6350 contact file to names, emails, phones and addresses |
| `XlsxRead` | A workbook to typed rows, shared strings resolved, formulas with cached values |
| `XlsxWrite` | Rows to a .xlsx with typed cells and an optional header row |

## What these will not do

**They will not decrypt.** A PDF with an `/Encrypt` entry, or a ZIP member with
the encrypted flag set, is reported as encrypted and refused. There is no
password path, not even for the empty user password.

**They will not OCR.** A scanned page has no text layer, and `PdfInfo` and
`PdfText` both say exactly that rather than returning an empty string that
reads like an empty document.

**They will not evaluate.** `XlsxRead` reports a formula's text alongside the
cached value the producing application last computed. It never recalculates,
and the field is called `cachedValue` so a stale workbook cannot be mistaken
for a fresh one.

**They will not claim more than they read.** A result that was cut short at
a character budget carries `truncated: true`, and `DocumentDiff` will not
report `identical` from two truncated extractions — it reports
`comparedTextIdentical` and says the tails were never compared. `PdfInfo`
distinguishes a page with no text layer (`hasTextLayer: false`, most likely a
scan) from a page whose content stream would not decode (`null`, not known to
be a scan at all), because sending someone to OCR over an unsupported filter
is a confidently wrong answer.

**They will not expand recurrences.** `IcsParse` returns `RRULE` as text.
Expanding one needs a calendar engine and a clock, and this package has
neither.

**They will not convert timezones.** A zoned `DTSTART` comes back with its
`TZID` as written. Converting it needs a timezone database, and a wrong
conversion is worse than an honest one.

`PdfSplit` and `PdfMerge` rebuild the page tree from scratch and deliberately
drop annotations, bookmarks, form fields and the structure tree — each of those
refers to pages by object reference, and in a split those pages are usually not
in the output. Both tools report what they dropped in their result.

## Reading a format nobody else in the workspace reads

A .docx, .xlsx and .pptx are all ZIP containers holding XML, so this package
carries its own ZIP reader (`src/lib/zip.ts`) and its own XML reader
(`src/lib/xml.ts`). Both are small, strict and documented down to the entry in
the format they do and do not handle. The XML reader has no entity resolver
and refuses a `DOCTYPE` with an internal subset outright, so neither XXE nor
the billion-laughs expansion has anywhere to happen.

The PDF reader (`src/lib/pdf.ts`) scans for objects sequentially rather than
trusting the cross-reference table, because real PDFs have broken tables
constantly — this is the "repair" path every viewer has, done first rather
than as a fallback. Object streams and cross-reference streams are expanded
afterwards for what the scan cannot see.

## Bounded memory

Every limit is enforced *before* the bytes exist. A file's size is checked
before it is read. A decompression cap is passed into the inflater as
`maxOutputLength`, so a zip bomb aborts mid-stream rather than after a hundred
megabytes are already resident — a cap applied to a buffer you have already
filled is not a cap. Entry counts, nesting depth, page counts and returned
characters are all bounded too.

This is why `node:zlib` is used rather than `Bun.inflateSync`: the Bun helper
has no output cap.

The same rule holds for the filters this package implements itself. PDF's
`RunLengthDecode` expands up to 64:1 and `ASCII85Decode` up to 4:1, so both
decode into a sink that refuses to grow past the cap as each byte is made,
not into a `number[]` that is measured afterwards — eight bytes per decoded
byte means a 1 MB stream can cost gigabytes before an after-the-fact check
ever runs. A predictor's `/Colors`, `/BitsPerComponent` and `/Columns` come
out of the file and are range-checked against the specification before a row
buffer is sized from them.

A page tree is walked under a flat visit budget as well as a depth limit. The
depth limit alone does not bound it: forty levels that each list the next one
twice is 2^40 walks with no cycle anywhere for a visited-set to catch.

## Determinism

Same bytes in, same bytes out. Listings sort with plain string comparison and
no locale. Nothing samples a random source. Nothing reads the clock: every
tool that stamps a timestamp — `DocxWrite`, `IcsWrite`, `PdfSplit`,
`PdfMerge` — takes it as an input, so writing the same content twice produces
byte-identical files. ZIP entries are written with the fixed MS-DOS epoch for
the same reason.

## Layout

`src/lib/` holds the format readers and writers and is where the behaviour is
tested; `src/index.ts` wraps them as tools. `src/fixtures.ts` *builds* the
binary fixtures — a .docx, a .xlsx, a .pptx and a PDF — byte by byte, so no
opaque blob is committed and every test states the bytes it is asserting
about. The PDF fixture builder shares no code with this package's PDF writer,
so a test that reads what it produces is testing the reader rather than
testing that the reader and writer agree with each other.

## Safety flags

The eleven readers are `readOnly`, non-destructive and `concurrencySafe`. The
five writers — `DocxWrite`, `XlsxWrite`, `IcsWrite`, `PdfSplit`, `PdfMerge` —
are `destructive` and neither of the other two. All sixteen are
`scope: "internal"` and declare no io capability: they touch local files and
nothing else, with no network and no subprocess anywhere in the package.
`src/index.test.ts` asserts every one of those flags, so a new tool with the
wrong stance fails the suite rather than shipping.

A failure the caller can act on — a malformed file, a path outside the
workspace, a format this package does not read — comes back as a sentence.
Anything else is a bug here and is rethrown rather than returned, so an
internal error message can never arrive in the place a document's text
belongs.

Every caller-supplied path goes through `src/paths.ts`, which refuses anything
resolving outside `process.cwd()` — including through a symlink that lives
inside the workspace and points out of it. An OOXML package whose member names
would escape their container is refused whole, before any part of it is read.
