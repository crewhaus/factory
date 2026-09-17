/**
 * iCalendar (RFC 5545) and vCard (RFC 6350) — one content-line grammar,
 * two vocabularies.
 *
 * ## The folding rule, which is where these formats are usually got wrong
 *
 * Both formats limit a line to 75 OCTETS and continue it by starting the
 * next line with a single space or tab. Unfolding therefore means removing
 * the line break AND EXACTLY ONE following whitespace character — not
 * trimming the continuation, which silently eats a space that was part of
 * the value, and not skipping the continuation, which truncates it. A fold
 * may also land in the middle of a multi-byte character, so unfolding
 * happens before any of the text is interpreted.
 *
 * ## Supported
 *
 * - Content lines: `NAME;PARAM=value;PARAM="quoted,value":VALUE`, with
 *   comma-separated multi-valued parameters and quoted parameter values.
 * - Nested components (`BEGIN:`/`END:`) to a bounded depth, so `VALARM`
 *   inside `VEVENT` inside `VCALENDAR` reads correctly.
 * - TEXT escaping in both directions: `\\n`, `\\N`, `\\,`, `\;`, `\\\\`.
 * - Date and date-time values in all three forms — floating
 *   (`20240115T090000`), UTC (`…Z`) and zoned (`TZID=Europe/Berlin`) — kept
 *   WITH their zone rather than converted, because converting requires a
 *   timezone database and a wrong conversion is worse than an honest one.
 * - `RRULE`, `RDATE` and `EXDATE` are carried through as their exact text.
 *   Nothing here expands a recurrence: that needs a calendar engine and a
 *   clock, and this package has neither.
 * - vCard 3.0 and 4.0 properties, including the `N` structured name and
 *   `ADR` structured address.
 *
 * ## Not supported — stated rather than faked
 *
 * - `VTIMEZONE` definitions are reported as present but their offset rules
 *   are not applied. A `TZID` is returned as written.
 * - Recurrence EXPANSION, free/busy computation and scheduling (`METHOD`,
 *   iTIP) semantics.
 * - vCard 2.1's quoted-printable property values (a pre-RFC dialect).
 */

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

export type ContentLine = {
  readonly name: string;
  readonly params: Readonly<Record<string, string[]>>;
  readonly value: string;
};

export type Component = {
  readonly name: string;
  readonly properties: ReadonlyArray<ContentLine>;
  readonly components: ReadonlyArray<Component>;
};

/**
 * Unfold, per RFC 5545 section 3.1: remove a line break followed by exactly
 * one space or tab. Handles CRLF, LF and bare CR.
 */
export function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
      continue;
    }
    out.push(line);
  }
  return out;
}

export function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    i += 1;
    switch (next) {
      case "n":
      case "N":
        out += "\n";
        break;
      case ",":
        out += ",";
        break;
      case ";":
        out += ";";
        break;
      case "\\":
        out += "\\";
        break;
      default:
        out += next ?? "\\";
    }
  }
  return out;
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\;");
}

/** Parse one unfolded content line. */
export function parseContentLine(line: string): ContentLine | null {
  if (line.trim() === "") return null;
  let i = 0;
  const readUntil = (stops: string): string => {
    let out = "";
    let inQuote = false;
    while (i < line.length) {
      const ch = line[i] as string;
      if (ch === '"') {
        inQuote = !inQuote;
        i += 1;
        continue;
      }
      if (!inQuote && stops.includes(ch)) break;
      out += ch;
      i += 1;
    }
    return out;
  };
  const name = readUntil(";:").toUpperCase();
  if (name === "") return null;
  const params: Record<string, string[]> = {};
  while (line[i] === ";") {
    i += 1;
    const paramName = readUntil("=;:").toUpperCase();
    let values: string[] = [];
    if (line[i] === "=") {
      i += 1;
      const raw = readUntil(";:");
      values = raw.split(",").map((v) => v.trim());
    }
    if (paramName !== "") params[paramName] = values;
  }
  if (line[i] === ":") i += 1;
  return { name, params, value: line.slice(i) };
}

/** Parse a whole file into its top-level components. */
export function parseComponents(text: string, maxDepth: number, maxLines: number): Component[] {
  const lines = unfold(text);
  if (lines.length > maxLines) {
    throw new CalendarError(`file has ${lines.length} lines, over the ${maxLines} limit`);
  }
  type Mutable = { name: string; properties: ContentLine[]; components: Component[] };
  const roots: Component[] = [];
  const stack: Mutable[] = [];
  for (const line of lines) {
    const parsed = parseContentLine(line);
    if (parsed === null) continue;
    if (parsed.name === "BEGIN") {
      if (stack.length >= maxDepth) {
        throw new CalendarError(`components nest deeper than ${maxDepth} levels`);
      }
      stack.push({ name: parsed.value.trim().toUpperCase(), properties: [], components: [] });
      continue;
    }
    if (parsed.name === "END") {
      const done = stack.pop();
      if (done === undefined) continue; // an END with no BEGIN; ignore it
      const parent = stack[stack.length - 1];
      if (parent === undefined) roots.push(done);
      else parent.components.push(done);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined) top.properties.push(parsed);
  }
  // An unterminated component still holds real data; keep what was read.
  while (stack.length > 0) {
    const done = stack.pop();
    if (done === undefined) break;
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(done);
    else parent.components.push(done);
  }
  return roots;
}

export function property(component: Component, name: string): ContentLine | undefined {
  for (const p of component.properties) if (p.name === name) return p;
  return undefined;
}

export function properties(component: Component, name: string): ContentLine[] {
  return component.properties.filter((p) => p.name === name);
}

// ---------------------------------------------------------------------------
// calendar events
// ---------------------------------------------------------------------------

export type CalendarDateTime = {
  /** The value exactly as written, e.g. `20240115T090000Z` or `20240115`. */
  readonly raw: string;
  /** ISO-8601, for the UTC and date-only forms where it is unambiguous. */
  readonly iso?: string;
  readonly timezone?: string;
  readonly dateOnly: boolean;
};

export type CalendarAttendee = {
  readonly address: string;
  readonly name?: string;
  readonly role?: string;
  readonly status?: string;
  readonly rsvp?: boolean;
};

export type CalendarAlarm = {
  readonly action?: string;
  readonly trigger?: string;
  readonly description?: string;
};

export type CalendarEvent = {
  readonly uid?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly status?: string;
  readonly start?: CalendarDateTime;
  readonly end?: CalendarDateTime;
  readonly duration?: string;
  readonly organizer?: CalendarAttendee;
  readonly attendees: ReadonlyArray<CalendarAttendee>;
  readonly rrule?: string;
  readonly exdate: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  readonly alarms: ReadonlyArray<CalendarAlarm>;
  readonly created?: string;
  readonly lastModified?: string;
  readonly sequence?: number;
  readonly recurrenceId?: string;
};

/**
 * Interpret a DATE or DATE-TIME value. A UTC value (`Z`) and a date-only
 * value have an unambiguous ISO form; a FLOATING or zoned value does not
 * without a timezone database, so `iso` is omitted for those and the raw
 * value plus its `TZID` is what the caller gets.
 */
export function parseCalendarDateTime(line: ContentLine): CalendarDateTime {
  const raw = line.value.trim();
  const tzid = line.params["TZID"]?.[0];
  const isDate = line.params["VALUE"]?.[0] === "DATE" || /^\d{8}$/.test(raw);
  const out: {
    raw: string;
    iso?: string;
    timezone?: string;
    dateOnly: boolean;
  } = { raw, dateOnly: isDate };
  if (tzid !== undefined) out.timezone = tzid;
  if (isDate && /^(\d{4})(\d{2})(\d{2})$/.test(raw)) {
    out.iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return out;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (match !== null && match[7] === "Z") {
    out.iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  }
  return out;
}

function parseAttendee(line: ContentLine): CalendarAttendee {
  const address = line.value.trim().replace(/^mailto:/i, "");
  const out: { address: string; name?: string; role?: string; status?: string; rsvp?: boolean } = {
    address,
  };
  const cn = line.params["CN"]?.join(",");
  if (cn !== undefined && cn !== "") out.name = cn;
  const role = line.params["ROLE"]?.[0];
  if (role !== undefined) out.role = role;
  const status = line.params["PARTSTAT"]?.[0];
  if (status !== undefined) out.status = status;
  const rsvp = line.params["RSVP"]?.[0];
  if (rsvp !== undefined) out.rsvp = rsvp.toUpperCase() === "TRUE";
  return out;
}

function textProperty(component: Component, name: string): string | undefined {
  const line = property(component, name);
  return line === undefined ? undefined : unescapeText(line.value);
}

export function readEvents(components: ReadonlyArray<Component>): {
  events: CalendarEvent[];
  calendarNames: string[];
  hasTimezones: boolean;
  otherComponents: string[];
} {
  const events: CalendarEvent[] = [];
  const calendarNames: string[] = [];
  const otherComponents = new Set<string>();
  let hasTimezones = false;

  const visit = (component: Component): void => {
    if (component.name === "VCALENDAR") {
      const name = textProperty(component, "X-WR-CALNAME");
      if (name !== undefined) calendarNames.push(name);
      for (const child of component.components) visit(child);
      return;
    }
    if (component.name === "VTIMEZONE") {
      hasTimezones = true;
      return;
    }
    if (component.name !== "VEVENT") {
      otherComponents.add(component.name);
      return;
    }
    const startLine = property(component, "DTSTART");
    const endLine = property(component, "DTEND");
    const organizerLine = property(component, "ORGANIZER");
    const event: {
      uid?: string;
      summary?: string;
      description?: string;
      location?: string;
      status?: string;
      start?: CalendarDateTime;
      end?: CalendarDateTime;
      duration?: string;
      organizer?: CalendarAttendee;
      attendees: CalendarAttendee[];
      rrule?: string;
      exdate: string[];
      categories: string[];
      alarms: CalendarAlarm[];
      created?: string;
      lastModified?: string;
      sequence?: number;
      recurrenceId?: string;
    } = {
      attendees: properties(component, "ATTENDEE").map(parseAttendee),
      exdate: properties(component, "EXDATE").flatMap((p) => p.value.split(",")),
      categories: properties(component, "CATEGORIES").flatMap((p) =>
        unescapeText(p.value)
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== ""),
      ),
      alarms: component.components
        .filter((c) => c.name === "VALARM")
        .map((alarm) => {
          const out: { action?: string; trigger?: string; description?: string } = {};
          const action = textProperty(alarm, "ACTION");
          if (action !== undefined) out.action = action;
          const trigger = property(alarm, "TRIGGER");
          if (trigger !== undefined) {
            const related = trigger.params["RELATED"]?.[0];
            out.trigger = related === undefined ? trigger.value : `${trigger.value} (${related})`;
          }
          const description = textProperty(alarm, "DESCRIPTION");
          if (description !== undefined) out.description = description;
          return out;
        }),
    };
    for (const [key, prop] of [
      ["uid", "UID"],
      ["summary", "SUMMARY"],
      ["description", "DESCRIPTION"],
      ["location", "LOCATION"],
      ["status", "STATUS"],
      ["duration", "DURATION"],
      ["created", "CREATED"],
      ["lastModified", "LAST-MODIFIED"],
      ["recurrenceId", "RECURRENCE-ID"],
    ] as const) {
      const value = textProperty(component, prop);
      if (value !== undefined) (event as Record<string, unknown>)[key] = value;
    }
    if (startLine !== undefined) event.start = parseCalendarDateTime(startLine);
    if (endLine !== undefined) event.end = parseCalendarDateTime(endLine);
    if (organizerLine !== undefined) event.organizer = parseAttendee(organizerLine);
    const rrule = property(component, "RRULE");
    if (rrule !== undefined) event.rrule = rrule.value;
    const sequence = property(component, "SEQUENCE");
    if (sequence !== undefined) {
      const parsed = Number.parseInt(sequence.value, 10);
      if (Number.isFinite(parsed)) event.sequence = parsed;
    }
    events.push(event);
  };

  for (const component of components) visit(component);
  return {
    events,
    calendarNames,
    hasTimezones,
    otherComponents: [...otherComponents].sort(),
  };
}

// ---------------------------------------------------------------------------
// writing iCalendar
// ---------------------------------------------------------------------------

/** Fold a content line at 75 OCTETS, not 75 characters. */
export function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (currentBytes + size > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
      limit = 74; // a continuation line spends one octet on its leading space
    }
    current += ch;
    currentBytes += size;
  }
  if (current !== "") out.push(current);
  return out.join("\r\n ");
}

export type EventInput = {
  readonly uid: string;
  readonly summary: string;
  /** `YYYY-MM-DD` for an all-day event, or an ISO-8601 instant ending in Z. */
  readonly start: string;
  readonly end?: string;
  readonly description?: string;
  readonly location?: string;
  readonly status?: string;
  readonly organizer?: string;
  readonly attendees?: ReadonlyArray<string>;
  readonly rrule?: string;
  readonly alarmMinutesBefore?: number;
  readonly timezone?: string;
};

/** ISO-8601 to an iCalendar DATE or DATE-TIME value. */
export function toCalendarValue(iso: string): { value: string; dateOnly: boolean } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  if (dateOnly) return { value: iso.replace(/-/g, ""), dateOnly: true };
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (match === null) {
    throw new CalendarError(`"${iso}" is not an ISO-8601 date or date-time`);
  }
  const [, y, mo, d, h, mi, s] = match;
  const utc = iso.endsWith("Z");
  return {
    value: `${y}${mo}${d}T${h}${mi}${s ?? "00"}${utc ? "Z" : ""}`,
    dateOnly: false,
  };
}

export type CalendarWriteOptions = {
  /** `DTSTAMP` for every event, as an ISO-8601 instant. An INPUT, not a clock. */
  readonly stamp: string;
  readonly productId?: string;
  readonly calendarName?: string;
};

/** Write a VCALENDAR. CRLF line endings, as RFC 5545 requires. */
export function writeCalendar(
  events: ReadonlyArray<EventInput>,
  options: CalendarWriteOptions,
): string {
  const stamp = toCalendarValue(options.stamp).value;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeText(options.productId ?? "-//crewhaus//tool-docs//EN")}`,
    "CALSCALE:GREGORIAN",
  ];
  if (options.calendarName !== undefined) {
    lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`);
  }
  for (const event of events) {
    const start = toCalendarValue(event.start);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(event.uid)}`);
    lines.push(`DTSTAMP:${stamp.endsWith("Z") ? stamp : `${stamp}Z`}`);
    const tzParam = event.timezone === undefined ? "" : `;TZID=${event.timezone}`;
    lines.push(
      start.dateOnly
        ? `DTSTART;VALUE=DATE:${start.value}`
        : `DTSTART${tzParam}:${start.value}`,
    );
    if (event.end !== undefined) {
      const end = toCalendarValue(event.end);
      lines.push(
        end.dateOnly ? `DTEND;VALUE=DATE:${end.value}` : `DTEND${tzParam}:${end.value}`,
      );
    }
    lines.push(`SUMMARY:${escapeText(event.summary)}`);
    if (event.description !== undefined) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    if (event.location !== undefined) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.status !== undefined) lines.push(`STATUS:${event.status.toUpperCase()}`);
    if (event.organizer !== undefined) lines.push(`ORGANIZER:mailto:${event.organizer}`);
    for (const attendee of event.attendees ?? []) {
      lines.push(`ATTENDEE;RSVP=TRUE:mailto:${attendee}`);
    }
    if (event.rrule !== undefined) lines.push(`RRULE:${event.rrule.replace(/^RRULE:/i, "")}`);
    if (event.alarmMinutesBefore !== undefined) {
      lines.push("BEGIN:VALARM");
      lines.push(`TRIGGER:-PT${Math.max(0, Math.round(event.alarmMinutesBefore))}M`);
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${escapeText(event.summary)}`);
      lines.push("END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

export type VcardTyped = { readonly value: string; readonly types: ReadonlyArray<string> };

export type Vcard = {
  readonly version?: string;
  readonly formattedName?: string;
  readonly name?: {
    readonly family?: string;
    readonly given?: string;
    readonly additional?: string;
    readonly prefix?: string;
    readonly suffix?: string;
  };
  readonly emails: ReadonlyArray<VcardTyped>;
  readonly phones: ReadonlyArray<VcardTyped>;
  readonly addresses: ReadonlyArray<{
    readonly types: ReadonlyArray<string>;
    readonly street?: string;
    readonly locality?: string;
    readonly region?: string;
    readonly postalCode?: string;
    readonly country?: string;
  }>;
  readonly organization?: string;
  readonly title?: string;
  readonly urls: ReadonlyArray<string>;
  readonly birthday?: string;
  readonly note?: string;
  readonly categories: ReadonlyArray<string>;
  /** Photos and logos are reported as present, never inlined. */
  readonly hasPhoto: boolean;
};

function typesOf(line: ContentLine): string[] {
  const types = line.params["TYPE"] ?? [];
  return types.map((t) => t.toLowerCase()).sort();
}

/** Structured values (`N`, `ADR`) are `;`-separated, honouring escapes. */
function splitStructured(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\") {
      current += ch + (value[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === ";") {
      out.push(unescapeText(current));
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(unescapeText(current));
  return out;
}

export function readVcards(components: ReadonlyArray<Component>): Vcard[] {
  const out: Vcard[] = [];
  const visit = (component: Component): void => {
    for (const child of component.components) visit(child);
    if (component.name !== "VCARD") return;
    const nLine = property(component, "N");
    const card: {
      version?: string;
      formattedName?: string;
      name?: Record<string, string>;
      emails: VcardTyped[];
      phones: VcardTyped[];
      addresses: Array<Record<string, unknown>>;
      organization?: string;
      title?: string;
      urls: string[];
      birthday?: string;
      note?: string;
      categories: string[];
      hasPhoto: boolean;
    } = {
      emails: properties(component, "EMAIL").map((l) => ({
        value: l.value.trim(),
        types: typesOf(l),
      })),
      phones: properties(component, "TEL").map((l) => ({
        value: l.value.trim().replace(/^tel:/i, ""),
        types: typesOf(l),
      })),
      addresses: properties(component, "ADR").map((l) => {
        // ADR is pobox;extended;street;locality;region;postal;country.
        const fields = splitStructured(l.value);
        const address: Record<string, unknown> = { types: typesOf(l) };
        for (const [key, index] of [
          ["street", 2],
          ["locality", 3],
          ["region", 4],
          ["postalCode", 5],
          ["country", 6],
        ] as const) {
          const field = fields[index];
          if (field !== undefined && field !== "") address[key] = field;
        }
        return address;
      }),
      urls: properties(component, "URL").map((l) => l.value.trim()),
      categories: properties(component, "CATEGORIES").flatMap((l) =>
        unescapeText(l.value)
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== ""),
      ),
      hasPhoto: property(component, "PHOTO") !== undefined || property(component, "LOGO") !== undefined,
    };
    for (const [key, prop] of [
      ["version", "VERSION"],
      ["formattedName", "FN"],
      ["title", "TITLE"],
      ["birthday", "BDAY"],
      ["note", "NOTE"],
    ] as const) {
      const value = textProperty(component, prop);
      if (value !== undefined) (card as Record<string, unknown>)[key] = value;
    }
    const org = property(component, "ORG");
    if (org !== undefined) {
      card.organization = splitStructured(org.value)
        .filter((part) => part !== "")
        .join(", ");
    }
    if (nLine !== undefined) {
      const fields = splitStructured(nLine.value);
      const name: Record<string, string> = {};
      for (const [key, index] of [
        ["family", 0],
        ["given", 1],
        ["additional", 2],
        ["prefix", 3],
        ["suffix", 4],
      ] as const) {
        const field = fields[index];
        if (field !== undefined && field !== "") name[key] = field;
      }
      if (Object.keys(name).length > 0) card.name = name;
    }
    out.push(card as unknown as Vcard);
  };
  for (const component of components) visit(component);
  return out;
}
