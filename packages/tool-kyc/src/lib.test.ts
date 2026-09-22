/**
 * The libraries, on their own: the VAT grammar and the register mappings, the
 * two company registers' normalizers, the name canonicalizer and the screening
 * policy.
 *
 * Nothing here opens a socket — these are pure functions over documents that
 * are written out in the test. The HTTP floor is exercised in `index.test.ts`
 * through the injected fetch.
 */
import { describe, expect, test } from "bun:test";
import {
  LEI_PATTERN,
  leiChecksumValid,
  normalizeEdgar,
  normalizeGleif,
  padCik,
  tickerIndex,
} from "./lib/entity";
import {
  alignTokens,
  buildTokenWeights,
  canonicalizeName,
  hasInvisibleCharacters,
  rankNames,
  rankNamesCapped,
  scoreEach,
  unseenTokenWeight,
} from "./lib/names";
import { KycNetworkError, getJson, readCapped } from "./lib/net";
import { type ListSnapshot, PREFILTER_FLOOR, checkSnapshot, screenSubjects } from "./lib/screen";
import {
  VAT_COUNTRIES,
  checkSyntax,
  gbCheckDigits,
  hmrcErrorMeaning,
  mapHmrcResponse,
  mapViesResponse,
  parseVatId,
} from "./lib/vat";

const NOW = Date.parse("2026-09-18T12:00:00Z");

function parsed(raw: string, country?: string) {
  const result = parseVatId(raw, country);
  if (!result.ok) throw new Error(`expected "${raw}" to parse: ${result.reason}`);
  return result;
}

// ---------------------------------------------------------------------------

describe("parseVatId", () => {
  test("reads the country from the prefix and strips separators", () => {
    expect(parsed("IE 63 88047-V")).toMatchObject({
      number: "6388047V",
      canonical: "IE6388047V",
    });
    expect(parsed("IE 63 88047-V").country.code).toBe("IE");
  });

  test("takes the country separately when the id has no prefix", () => {
    expect(parsed("123456782", "gb").canonical).toBe("GB123456782");
  });

  test("Greece files under EL, and an id written GR is accepted as EL", () => {
    // The ISO code is GR and the VAT prefix is EL. A tool that sends GR to
    // VIES gets INVALID_INPUT for a perfectly good Greek number.
    expect(parsed("GR123456789").country.code).toBe("EL");
    expect(parsed("123456789", "GR").canonical).toBe("EL123456789");
  });

  test("a prefix that contradicts the declared country is an error, not a preference", () => {
    const result = parseVatId("IE6388047V", "IT");
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("one of them is wrong");
  });

  test("an unknown country is refused by name", () => {
    const result = parseVatId("123456789", "US");
    expect(result.ok === false && result.reason).toContain("not an EU member state");
  });

  test("an id with no prefix and no declared country is refused", () => {
    const result = parseVatId("123456789");
    expect(result.ok === false && result.reason).toContain("no recognised country prefix");
  });

  test("a country code with nothing after it is refused", () => {
    const result = parseVatId("IE");
    expect(result.ok === false && result.reason).toContain("no number after it");
  });
});

describe("checkSyntax", () => {
  test("accepts all three Irish forms, including the letter in the middle", () => {
    // 1X34567A is the form a length-only check accepts by accident and a
    // digits-only check rejects outright.
    for (const id of ["IE6388047V", "IE1X34567A", "IE1234567FA"]) {
      expect({ id, wellFormed: checkSyntax(parsed(id)).wellFormed }).toEqual({
        id,
        wellFormed: true,
      });
    }
  });

  test("the Dutch B is positional, not a suffix", () => {
    expect(checkSyntax(parsed("NL123456789B01")).wellFormed).toBe(true);
    expect(checkSyntax(parsed("NL123456789012")).wellFormed).toBe(false);
    expect(checkSyntax(parsed("NL12345678B012")).wellFormed).toBe(false);
  });

  test("Spain allows a letter at either end and France excludes I and O", () => {
    expect(checkSyntax(parsed("ESX1234567X")).wellFormed).toBe(true);
    expect(checkSyntax(parsed("ES12345678Z")).wellFormed).toBe(true);
    // Nine characters, always: an eight-character Spanish id is not a short
    // one, it is a wrong one.
    expect(checkSyntax(parsed("ES12345678")).wellFormed).toBe(false);
    expect(checkSyntax(parsed("FRXX123456789")).wellFormed).toBe(true);
    expect(checkSyntax(parsed("FRIO123456789")).wellFormed).toBe(false);
  });

  test("a refusal names the shape it checked against", () => {
    const syntax = checkSyntax(parsed("DE12345"));
    expect(syntax.wellFormed).toBe(false);
    expect(syntax.reason).toContain("9 digits");
    expect(syntax.reason).toContain("Germany");
  });

  test("a country we have no checksum for says so rather than reporting a pass", () => {
    const syntax = checkSyntax(parsed("DE123456789"));
    expect(syntax.wellFormed).toBe(true);
    // The trap this closes: `passed: true` from an unimplemented algorithm
    // turns "we did not check" into "we checked and it was fine".
    expect(syntax.checksum.passed).toBeNull();
    expect(syntax.checksum.note).toContain("well-formed and nothing more");
  });

  test("every country in the table has a pattern and a shape in words", () => {
    const codes = Object.keys(VAT_COUNTRIES);
    expect(codes.length).toBeGreaterThanOrEqual(29);
    for (const code of codes) {
      const country = VAT_COUNTRIES[code];
      expect({ code, hasShape: (country?.shape.length ?? 0) > 3 }).toEqual({
        code,
        hasShape: true,
      });
      expect({ code, key: country?.code }).toEqual({ code, key: code });
    }
  });
});

describe("gbCheckDigits", () => {
  test("accepts both variants in circulation and rejects one that matches neither", () => {
    expect(gbCheckDigits("123456782")).toMatchObject({ algorithm: "mod-97", passed: true });
    // Issued from 2004: the same weighted sum plus 55. A number issued under
    // one variant is not invalid for failing the other.
    expect(gbCheckDigits("123456727")).toMatchObject({ algorithm: "mod-9755", passed: true });
    expect(gbCheckDigits("123456789")).toMatchObject({ passed: false });
  });

  test("a branch suffix is ignored and GD/HA numbers carry no check digits", () => {
    expect(gbCheckDigits("123456782001").passed).toBe(true);
    expect(gbCheckDigits("GD001")).toMatchObject({ algorithm: "none", passed: null });
    expect(gbCheckDigits("HA501").passed).toBeNull();
  });
});

describe("mapViesResponse", () => {
  test("a confirmed registration is found, with the registration details", () => {
    const answer = mapViesResponse(
      {
        isValid: true,
        userError: "VALID",
        name: "ACME TRADING LIMITED",
        address: "1 DOCK RD, DUBLIN",
        requestDate: "2026-09-18+01:00",
      },
      false,
    );
    expect(answer.outcome).toBe("found");
    expect(answer.registration).toMatchObject({ name: "ACME TRADING LIMITED" });
    expect(answer.consultationNumberAbsent).toContain("no requesterVatId");
  });

  test("a confirmed non-registration is notFound", () => {
    expect(mapViesResponse({ isValid: false, userError: "VALID" }, false).outcome).toBe("notFound");
  });

  test("a member state being down is unavailable and retryable — never notFound", () => {
    // The defect this whole package exists to prevent: an outage read as
    // "this VAT number is not valid" changes an invoice's VAT treatment.
    const answer = mapViesResponse({ isValid: false, userError: "MS_UNAVAILABLE" }, false);
    expect(answer.outcome).toBe("unavailable");
    expect(answer.retryable).toBe(true);
    expect(answer.basis).toContain("member state's own system did not answer");
  });

  test("every non-answering VIES code is unavailable, and each says which", () => {
    const codes = [
      "SERVICE_UNAVAILABLE",
      "MS_MAX_CONCURRENT_REQ",
      "GLOBAL_MAX_CONCURRENT_REQ",
      "TIMEOUT",
      "IP_BLOCKED",
      "VAT_BLOCKED",
      "INVALID_INPUT",
      "INVALID_REQUESTER_INFO",
    ];
    for (const code of codes) {
      const answer = mapViesResponse({ isValid: false, userError: code }, false);
      expect({ code, outcome: answer.outcome }).toEqual({ code, outcome: "unavailable" });
      expect({ code, quoted: answer.code }).toEqual({ code, quoted: code });
    }
  });

  test("INVALID_INPUT does not mean the number is unregistered", () => {
    // VIES answers this when it rejected the REQUEST — it never asked the
    // member state, so it has said nothing about the number.
    const answer = mapViesResponse({ isValid: false, userError: "INVALID_INPUT" }, false);
    expect(answer.outcome).toBe("unavailable");
    expect(answer.retryable).toBe(false);
    expect(answer.basis).toContain("never asked the member state");
  });

  test("a bad requester id fails the whole call and says how to get an answer anyway", () => {
    const answer = mapViesResponse({ isValid: false, userError: "INVALID_REQUESTER_INFO" }, true);
    expect(answer.basis).toContain("retry without requesterVatId");
  });

  test("a code we have never seen is unavailable, quoted, not guessed at", () => {
    const answer = mapViesResponse({ isValid: false, userError: "MS_ON_FIRE" }, false);
    expect(answer.outcome).toBe("unavailable");
    expect(answer.basis).toContain('"MS_ON_FIRE"');
    expect(answer.basis).toContain("refusing to guess");
  });

  test("VALID with isValid false is the member state answering no", () => {
    expect(mapViesResponse({ isValid: false, userError: "VALID" }, false).outcome).toBe("notFound");
  });

  test("a response with neither field is unreadable, not an answer", () => {
    expect(mapViesResponse({ requestDate: "2026-09-18+01:00" }, false)).toMatchObject({
      outcome: "unavailable",
    });
  });

  test("the consultation number comes through when VIES issued one", () => {
    const answer = mapViesResponse(
      { isValid: true, userError: "VALID", requestIdentifier: "WAPIAAAAXY1234567" },
      true,
    );
    expect(answer.consultationNumber).toBe("WAPIAAAAXY1234567");
    expect(answer.consultationNumberAbsent).toBeUndefined();
  });

  test("a requester that produced no consultation number says so", () => {
    const answer = mapViesResponse({ isValid: true, userError: "VALID" }, true);
    expect(answer.consultationNumberAbsent).toContain("a requester was supplied");
  });

  test("VIES's own approximate name verdict is carried, not recomputed", () => {
    const answer = mapViesResponse(
      { isValid: true, userError: "VALID", viesApproximate: { matchName: "1" } },
      false,
    );
    expect(answer.nameMatch).toBe("1");
  });
});

describe("mapHmrcResponse", () => {
  test("a target is a registration, with the address assembled in order", () => {
    const answer = mapHmrcResponse(
      {
        target: {
          name: "ACME LTD",
          vatNumber: "123456782",
          address: { line1: "1 High St", postcode: "SW1A 1AA", countryCode: "GB" },
        },
        processingDate: "2026-09-18T00:00:00+00:00",
        consultationNumber: "ABC-1234",
      },
      true,
    );
    expect(answer.outcome).toBe("found");
    expect(answer.registration?.address).toBe("1 High St, SW1A 1AA, GB");
    expect(answer.consultationNumber).toBe("ABC-1234");
  });

  test("a 200 with no target is unreadable, not evidence of non-registration", () => {
    const answer = mapHmrcResponse({ processingDate: "2026-09-18T00:00:00+00:00" }, false);
    expect(answer.outcome).toBe("unavailable");
    expect(answer.basis).toContain("not evidence that a number is unregistered");
  });

  test("HMRC's error codes each have a meaning", () => {
    expect(hmrcErrorMeaning("NOT_FOUND", 404)).toContain("not registered");
    expect(hmrcErrorMeaning("SCHEDULED_MAINTENANCE", 503)).toContain("maintenance");
    expect(hmrcErrorMeaning(undefined, 502)).toContain("502");
  });
});

// ---------------------------------------------------------------------------

describe("LEI check digits", () => {
  test("ISO 7064 MOD 97-10 accepts real LEIs and rejects a transposed character", () => {
    expect(leiChecksumValid("5493001KJTIIGC8Y1R12")).toBe(true);
    expect(leiChecksumValid("549300ABCDEFGHIJ0088")).toBe(true);
    expect(leiChecksumValid("213800QPZ4ZQOZAF2S94")).toBe(true);
    expect(leiChecksumValid("549300ABCDEFGHIJ0000")).toBe(false);
    // One character different is the case the check exists for.
    expect(leiChecksumValid("5493001KJTIIGC8Y1R13")).toBe(false);
  });

  test("case does not matter, but shape does", () => {
    expect(leiChecksumValid("5493001kjtiigc8y1r12")).toBe(true);
    expect(leiChecksumValid("5493001KJTIIGC8Y1R1")).toBe(false);
    expect(leiChecksumValid("5493001KJTIIGC8Y1RAB")).toBe(false);
    expect(LEI_PATTERN.test("5493001KJTIIGC8Y1R12")).toBe(true);
  });
});

describe("padCik", () => {
  test("pads to ten digits, with or without the CIK prefix", () => {
    // `CIK320193.json` is a 404, which would read as "Apple does not file".
    expect(padCik("320193")).toBe("0000320193");
    expect(padCik("CIK0000320193")).toBe("0000320193");
    expect(padCik(320193)).toBe("0000320193");
  });

  test("refuses what is not a CIK", () => {
    expect(padCik("AAPL")).toBeNull();
    expect(padCik("12345678901")).toBeNull();
    expect(padCik("")).toBeNull();
  });
});

describe("tickerIndex", () => {
  const document = {
    "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    "1": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
    "2": { cik_str: 999999, ticker: "AAPL", title: "Apple Inc. (second listing)" },
    "3": { ticker: "NOCIK" },
    "4": { cik_str: "not-a-number", ticker: "BAD" },
  };

  test("maps tickers to padded CIKs, first spelling winning", () => {
    const index = tickerIndex(document);
    expect(index.get("AAPL")).toMatchObject({ cik: "0000320193" });
    expect(index.get("MSFT")?.cik).toBe("0000789019");
    expect(index.has("NOCIK")).toBe(false);
    expect(index.has("BAD")).toBe(false);
  });
});

describe("normalizeGleif", () => {
  const attributes = {
    lei: "5493001KJTIIGC8Y1R12",
    entity: {
      legalName: { name: "ACME TRADING LIMITED" },
      otherNames: [{ name: "Acme Trading" }],
      transliteratedOtherNames: [{ name: "AKME TREJDING" }],
      legalAddress: { addressLines: ["1 Dock Rd"], city: "Dublin", country: "IE" },
      status: "ACTIVE",
      jurisdiction: "IE",
      legalForm: { id: "H0PO" },
      registeredAs: "123456",
    },
    registration: {
      status: "LAPSED",
      initialRegistrationDate: "2015-01-01T00:00:00Z",
      nextRenewalDate: "2026-01-01T00:00:00Z",
    },
  };

  test("keeps GLEIF's two statuses apart", () => {
    // entity.status answers "is the company there"; registration.status
    // answers "is the LEI paid up". A LAPSED LEI on an ACTIVE company is an
    // unpaid renewal fee, and collapsing the two would hold a payment to a
    // live supplier over ninety euros.
    const record = normalizeGleif(attributes);
    expect(record?.status).toEqual({ entityStatus: "ACTIVE", registrationStatus: "LAPSED" });
    expect(Object.keys(record?.status ?? {})).not.toContain("active");
  });

  test("carries other and transliterated names, the address and the local register id", () => {
    const record = normalizeGleif(attributes);
    expect(record?.otherNames).toEqual(["Acme Trading", "AKME TREJDING"]);
    expect(record?.address).toBe("1 Dock Rd, Dublin, IE");
    expect(record?.identifiers).toMatchObject({ registeredAs: "123456" });
    expect(record?.dates).toMatchObject({ leiNextRenewal: "2026-01-01T00:00:00Z" });
  });

  test("a body with neither a name nor an LEI is null, not an empty record", () => {
    expect(normalizeGleif({ entity: {} })).toBeNull();
    expect(normalizeGleif(undefined)).toBeNull();
  });
});

describe("normalizeEdgar", () => {
  const document = {
    cik: "320193",
    name: "Apple Inc.",
    tickers: ["AAPL"],
    ein: "942404110",
    entityType: "operating",
    sic: "3571",
    sicDescription: "Electronic Computers",
    stateOfIncorporation: "CA",
    formerNames: [{ name: "APPLE COMPUTER INC", from: "1994-01-01", to: "2007-01-01" }],
    addresses: {
      business: { street1: "One Apple Park Way", city: "Cupertino", stateOrCountry: "CA" },
    },
    filings: { recent: { form: ["10-K", "8-K"], filingDate: ["2026-08-01", "2026-07-01"] } },
  };

  test("keeps former names, which is what turns a rename into a rename", () => {
    const record = normalizeEdgar(document);
    expect(record?.otherNames).toEqual(["APPLE COMPUTER INC"]);
    expect(record?.identifiers).toMatchObject({ cik: "0000320193", ein: "942404110" });
  });

  test("reports the latest filing as activity, not as a registration status", () => {
    const record = normalizeEdgar(document);
    expect(record?.status["latestFiling"]).toBe("10-K on 2026-08-01");
    expect(record?.status["entityStatus"]).toBeUndefined();
  });

  test("a filer with no filings says so rather than looking dormant by omission", () => {
    const record = normalizeEdgar({ cik: "1", name: "Quiet Co", filings: {} });
    expect(record?.status["filingActivity"]).toBe("no filings in the document");
  });

  test("a body that is not a submissions document is null", () => {
    expect(normalizeEdgar({ error: "nope" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("canonicalizeName", () => {
  test("folds diacritics, case and punctuation into comparable tokens", () => {
    // tool-text's NormalizeText does the Unicode form and the invisibles; the
    // diacritic fold is this package's, because a diff must NOT fold them and
    // a name must.
    return canonicalizeName("Müller-Ødegård, Ekaterina").then((name) => {
      expect(name.canonical).toBe("muller odegard ekaterina");
      expect(name.tokens.length).toBe(3);
    });
  });

  test("normalizes full-width characters through NFKC", async () => {
    const name = await canonicalizeName("ＡＣＭＥ　ＴＲＡＤＩＮＧ");
    expect(name.canonical).toBe("acme trading");
  });

  test("strips zero-width characters and reports that it did", async () => {
    // An evasion, not a typo: a zero-width joiner inside a name makes it miss
    // a list it should hit, and nothing in a rendered result would show it.
    const sneaky = `Acme${String.fromCharCode(0x200b)} Trading`;
    const name = await canonicalizeName(sneaky, { dropLegalSuffixes: true });
    expect(name.canonical).toBe("acme trading");
    expect(name.hadInvisibleCharacters).toBe(true);
    expect(hasInvisibleCharacters("Acme Trading")).toBe(false);
  });

  test("drops legal forms from organisations and records which", async () => {
    const name = await canonicalizeName("ACME Trading Ltd.", { dropLegalSuffixes: true });
    expect(name.canonical).toBe("acme trading");
    expect(name.droppedSuffixes).toEqual(["ltd"]);
  });

  test("never drops every token: a name that is only a legal form keeps it", async () => {
    const name = await canonicalizeName("Limited", { dropLegalSuffixes: true });
    expect(name.canonical).toBe("limited");
    expect(name.droppedSuffixes).toEqual([]);
  });

  test("leaves a person's name alone", async () => {
    const name = await canonicalizeName("Marco Sa", { dropLegalSuffixes: false });
    expect(name.tokens).toEqual(["marco", "sa"]);
  });
});

describe("rankNames", () => {
  test("ranks best first and honours the floor", async () => {
    const hits = await rankNames("acme trading", ["acme trading", "acme tradinq", "zzz"], 0.6, 5);
    expect(hits[0]?.candidate).toBe("acme trading");
    expect(hits.map((h) => h.candidate)).not.toContain("zzz");
  });

  test("ties break on the original index, so two runs agree", async () => {
    const candidates = ["same name", "same name", "same name"];
    const first = await rankNames("same name", candidates, 0.5, 3);
    const second = await rankNames("same name", candidates, 0.5, 3);
    expect(first.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(first).toEqual(second);
  });

  test("indexes stay global when the candidate list spans several chunks", async () => {
    // 10 001 candidates is one more than FuzzyMatch's per-call cap, so the
    // second chunk's indexes have to be offset — an off-by-one here points a
    // candidate at the wrong list entry, which is the worst kind of wrong
    // answer this package can give.
    const candidates = Array.from({ length: 10_005 }, (_, i) => `company number ${i}`);
    const hits = await rankNames("company number 10004", candidates, 0.9, 3);
    expect(hits[0]?.index).toBe(10_004);
    expect(candidates[hits[0]?.index ?? -1]).toBe("company number 10004");
    // BUDGET: 10 005 Jaro-Winkler comparisons through two tool round trips.
    // ~150ms here; CI is a loaded two-core box on an older bun.
  }, 20_000);

  test("`capped` comes from the ranker, because the caller cannot infer it", async () => {
    // Asking for 250 hits gets at most 100, so a caller comparing its own hit
    // count with 250 can never see the cut. The flag is the only signal there
    // is, and it has to be true here and false when nothing was dropped.
    const candidates = Array.from({ length: 150 }, (_, i) => `acme trading ${i}`);
    expect((await rankNamesCapped("acme trading", candidates, 0.5, 250)).capped).toBe(true);
    expect((await rankNamesCapped("acme trading", candidates.slice(0, 40), 0.5, 250)).capped).toBe(
      false,
    );
  });

  test("scoreEach scores every candidate, including past the hundredth", async () => {
    // Chunked at the HITS cap rather than the candidates cap. Getting that
    // wrong returns 0 for the tail, and a 0 in `scoreWholeString` is a number
    // that reads as "the whole-string pass looked and found nothing alike"
    // rather than as "this was never scored".
    const candidates = Array.from({ length: 250 }, (_, i) => `entry ${i}`);
    const scores = await scoreEach("entry 249", candidates);
    expect(scores).toHaveLength(250);
    expect(scores.filter((s) => s === 0)).toEqual([]);
    expect(scores[249]).toBe(1);
    // The argmax must be the last one, which only holds if index 249 was
    // reached by the third chunk with its offset applied.
    expect(scores.indexOf(Math.max(...scores))).toBe(249);
  });
});

describe("token weighting", () => {
  test("a token in every entry weighs less than one in a single entry", () => {
    const weights = buildTokenWeights([
      ["mohammed", "hassan"],
      ["mohammed", "ali"],
      ["mohammed", "khan"],
      ["mohammed", "rafiq"],
    ]);
    expect(weights.get("mohammed")).toBeLessThan(weights.get("hassan") as number);
  });

  test("a token the lists have never seen is at least as heavy as the rarest one", () => {
    const weights = buildTokenWeights([["a"], ["b"], ["c"]]);
    expect(unseenTokenWeight(3)).toBeGreaterThanOrEqual(weights.get("a") as number);
  });

  test("alignment pairs each subject token with its best partner", async () => {
    const { alignments, score } = await alignTokens(
      ["mohamed", "kharoubi"],
      ["mohammed", "kharoubi"],
      () => 1,
    );
    expect(alignments.map((a) => a.entryToken)).toEqual(["mohammed", "kharoubi"]);
    expect(score).toBeGreaterThan(0.95);
  });

  test("a token with no partner scores zero and says so, rather than being skipped", async () => {
    const { alignments } = await alignTokens(["zeppelin"], ["mohammed"], () => 1);
    expect(alignments[0]).toMatchObject({ entryToken: null, score: 0 });
  });

  test("an entry with no tokens at all does not throw", async () => {
    const { score } = await alignTokens(["anything"], [], () => 1);
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<ListSnapshot> = {}): ListSnapshot {
  return {
    source: "OFAC SDN",
    version: "20260917",
    publishedAt: "2026-09-17T00:00:00Z",
    retrievedAt: "2026-09-17T06:00:00Z",
    entries: [{ id: "1", name: "Ivan Petrov", kind: "person" }],
    ...overrides,
  };
}

describe("checkSnapshot", () => {
  test("accepts a fresh list and reports its age", () => {
    expect(checkSnapshot(snapshot(), NOW, 30)).toEqual({ ageDays: 1 });
  });

  test("refuses a timestamp with no UTC offset, naming the field", () => {
    const result = checkSnapshot(snapshot({ publishedAt: "2026-09-17T00:00:00" }), NOW, 30);
    expect("reason" in result && result.reason).toContain("publishedAt");
    expect("reason" in result && result.reason).toContain("no UTC offset");
  });

  test("refuses an empty list, because empty reads exactly like clean", () => {
    const result = checkSnapshot(snapshot({ entries: [] }), NOW, 30);
    expect("reason" in result && result.reason).toContain("reads exactly like a clean screen");
  });

  test("refuses a stale list, with the age and the limit in the reason", () => {
    const result = checkSnapshot(snapshot({ publishedAt: "2026-01-01T00:00:00Z" }), NOW, 30);
    expect("reason" in result && result.reason).toContain("260 days ago");
    expect("reason" in result && result.reason).toContain("30-day limit");
  });

  test("maxAgeDays of 0 disables the staleness check deliberately", () => {
    expect(checkSnapshot(snapshot({ publishedAt: "2020-01-01T00:00:00Z" }), NOW, 0)).toMatchObject({
      ageDays: expect.any(Number),
    });
  });

  test("a publishedAt after retrievedAt is refused, not clamped to an age of zero", () => {
    // Age is `max(0, now - published)`, so a mistyped year in publishedAt
    // reported `ageDays: 0` and sailed through the staleness gate FOREVER —
    // the control could not be evaluated and counted as one that held, on an
    // evidence record that then read "published today". A copy cannot predate
    // what it is a copy of, so the ordering catches it without a tolerance.
    const result = checkSnapshot(
      snapshot({ publishedAt: "2062-09-17T00:00:00Z", retrievedAt: "2026-09-17T06:00:00Z" }),
      NOW,
      30,
    );
    expect("ageDays" in result).toBe(false);
    expect("reason" in result && result.reason).toContain("cannot predate");
  });

  test("a snapshot retrieved after the screening ran is refused", () => {
    // The other half: a year typo in BOTH dates keeps them consistent with
    // each other and still turns the gate off. Nothing can have been retrieved
    // after the screen that reads it.
    const result = checkSnapshot(
      snapshot({ publishedAt: "2062-09-17T00:00:00Z", retrievedAt: "2062-09-17T06:00:00Z" }),
      NOW,
      30,
    );
    expect("ageDays" in result).toBe(false);
    expect("reason" in result && result.reason).toContain("after the screening ran");
  });
});

describe("screenSubjects", () => {
  const policy = { threshold: 0.65, limit: 10, includeWeakAliases: true };

  const sdn = snapshot({
    entries: [
      {
        id: "SDN-1",
        name: "Mohammed Kharoubi",
        kind: "person",
        countries: ["SY"],
        datesOfBirth: ["1965-03-02"],
        programs: ["SDGT"],
        aliases: [
          { name: "Muhammad al-Kharubi", quality: "strong" },
          { name: "Abu Mohammed", quality: "weak" },
        ],
      },
      { id: "SDN-2", name: "Mohammed Rafiq", kind: "person", countries: ["PK"] },
      { id: "SDN-3", name: "Mohammed Ali Shah", kind: "person" },
      { id: "SDN-4", name: "Sovcomflot Shipping Co", kind: "entity" },
    ],
  });

  test("an exact name scores at the top and reports what it matched on", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Mohammed Kharoubi", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const [subject] = result.subjects;
    expect(subject?.candidates[0]).toMatchObject({
      entryId: "SDN-1",
      matchedOn: "primary",
      aliasQuality: "strong",
      list: "OFAC SDN",
      listVersion: "20260917",
    });
    expect(subject?.candidates[0]?.score).toBeGreaterThan(0.99);
  });

  test("a transliteration still matches, which a token-equality check would miss", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Mohamed Al Kharubi", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const top = result.subjects[0]?.candidates[0];
    expect(top?.entryId).toBe("SDN-1");
    expect(top?.score).toBeGreaterThan(policy.threshold);
  });

  test("a shared common given name is not a candidate on its own", async () => {
    // The flat token-set ratio's failure: "Mohammed" appears on three of four
    // entries, so matching it is worth almost nothing, and the rest of the
    // name has to carry the score.
    const result = await screenSubjects(
      [{ id: "s1", name: "Mohammed Svensson", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    expect(result.subjects[0]?.candidates).toEqual([]);
    expect(result.subjects[0]?.bestScoreBelowThreshold).not.toBeNull();
  });

  test("a one-token subject does not score 1.0 against every entry containing it", async () => {
    // Scoring only the subject's tokens into the entry gives "Mohammed" a
    // perfect score against three entries. The reverse direction is what
    // makes the entry's unmatched tokens cost something.
    const result = await screenSubjects(
      [{ id: "s1", name: "Mohammed", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    for (const candidate of result.subjects[0]?.candidates ?? []) {
      expect({ id: candidate.entryId, perfect: candidate.score >= 1 }).toEqual({
        id: candidate.entryId,
        perfect: false,
      });
    }
  });

  test("weak aliases are scored apart and never mixed into the candidates", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Abu Mohammed", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const subject = result.subjects[0];
    expect(subject?.candidates.every((c) => c.aliasQuality === "strong")).toBe(true);
    expect(subject?.weakAliasCandidates[0]).toMatchObject({
      aliasQuality: "weak",
      matchedOn: "alias",
    });
  });

  test("includeWeakAliases false leaves them out entirely", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Abu Mohammed", kind: "person" }],
      [sdn],
      [1],
      { ...policy, includeWeakAliases: false },
      NOW,
    );
    expect(result.subjects[0]?.weakAliasCandidates).toEqual([]);
  });

  test("a country that differs does not lower the score or drop the candidate", async () => {
    // Most entries carry no country at all, so letting a mismatch clear a hit
    // would clear hardest on the least complete — and oldest — entries.
    const withCountry = await screenSubjects(
      [{ id: "s1", name: "Mohammed Kharoubi", kind: "person", country: "DE" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const withoutCountry = await screenSubjects(
      [{ id: "s1", name: "Mohammed Kharoubi", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    expect(withCountry.subjects[0]?.candidates[0]?.score).toBe(
      withoutCountry.subjects[0]?.candidates[0]?.score as number,
    );
    expect(withCountry.subjects[0]?.candidates[0]?.corroboration).toMatchObject({
      country: "differs (entry: SY)",
      usedForScoring: false,
    });
  });

  test("a date of birth corroborates by year when the day differs", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Mohammed Kharoubi", kind: "person", dateOfBirth: "1965-11-30" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    expect(result.subjects[0]?.candidates[0]?.corroboration.dateOfBirth).toBe(
      "year matches, day differs",
    );
  });

  test("legal forms come off a company name and are recorded", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Sovcomflot Shipping Limited", kind: "entity" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const top = result.subjects[0]?.candidates[0];
    expect(top?.entryId).toBe("SDN-4");
    expect(top?.droppedSuffixes).toEqual(["co"]);
  });

  test("no candidate is not a clearance, and the near miss is reported", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Grace O'Malley", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    expect(result.subjects[0]?.candidates).toEqual([]);
    expect(result.subjects[0]?.note).toContain("not a clearance");
  });

  test("the evidence record carries every list's version, dates and size", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Ivan Petrov", kind: "person" }],
      [sdn, snapshot({ source: "UK OFSI", version: "2026-09-16" })],
      [1, 2],
      policy,
      NOW,
    );
    expect(result.evidence.lists).toEqual([
      expect.objectContaining({ source: "OFAC SDN", version: "20260917", entries: 4, names: 6 }),
      expect.objectContaining({ source: "UK OFSI", version: "2026-09-16", entries: 1, names: 1 }),
    ]);
    expect(result.evidence.screenedAt).toBe("2026-09-18T12:00:00.000Z");
    expect(result.evidence.policy.matcher).toContain("tool-text");
  });

  test("no verdict anywhere in the result", async () => {
    const result = await screenSubjects(
      [{ id: "s1", name: "Mohammed Kharoubi", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const text = JSON.stringify(result);
    expect(result.note).toContain("a determination a person makes");
    for (const forbidden of ['"sanctioned"', '"blocked"', '"match":true', '"clear"']) {
      expect({ forbidden, present: text.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  test("two runs over the same snapshot produce byte-identical output", async () => {
    const subjects = [
      { id: "s1", name: "Mohammed Kharoubi", kind: "person" as const },
      { id: "s2", name: "Sovcomflot Shipping Co", kind: "entity" as const },
    ];
    const first = JSON.stringify(await screenSubjects(subjects, [sdn], [1], policy, NOW));
    const second = JSON.stringify(await screenSubjects(subjects, [sdn], [1], policy, NOW));
    expect(first).toBe(second);
  });

  test("the prefilter floor is below the reporting threshold on purpose", () => {
    // If the filter ran at the reporting threshold, the token pass could never
    // raise a pair the whole-string pass scored low — which is the only reason
    // the token pass exists.
    expect(PREFILTER_FLOOR).toBeLessThan(policy.threshold);
  });

  test("a subject given as a surname alone still reaches the entry that names him", async () => {
    // The false clean this package exists to prevent, and the one it produced.
    // Jaro-Winkler rewards a shared PREFIX, so "Mohammed" against "Mohammed
    // Kharoubi" is 0.89 and "Kharoubi" against the same entry is 0.35 — under
    // any floor loose enough to be useful. A whole-string-only shortlist
    // therefore answered "no candidates, no near miss, nothing truncated" for
    // a person who is on the list, purely because the operator typed the
    // surname. The token pass is what closes it.
    const result = await screenSubjects(
      [{ id: "s1", name: "Kharoubi", kind: "person" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    const top = result.subjects[0]?.candidates[0];
    expect(top?.entryId).toBe("SDN-1");
    // Asserting the REASON, not just the hit: the candidate is here despite a
    // whole-string score below the floor, which is only possible if the token
    // pass shortlisted it. A test that checked the hit alone would also pass
    // if somebody "fixed" this by dropping the floor to 0.3 and drowning the
    // operator in every name on the list.
    expect(top?.scoreWholeString).toBeLessThan(PREFILTER_FLOOR);
    expect(top?.scoreForward).toBe(1);
    expect(top?.alignments[0]).toMatchObject({ subjectToken: "kharoubi", entryToken: "kharoubi" });
  });

  test("a company given by its distinctive word alone is shortlisted too", async () => {
    // Same defect, the entity half: "Sovcomflot" against "Sovcomflot Shipping
    // Co" happens to score well on the whole string, so the regression above
    // needs its mirror — a word that sits at the END of the entry's name.
    const result = await screenSubjects(
      [{ id: "s1", name: "Shipping Sovcomflot", kind: "entity" }],
      [sdn],
      [1],
      policy,
      NOW,
    );
    expect(result.subjects[0]?.candidates[0]?.entryId).toBe("SDN-4");
  });

  test("the prefilter reports truncation even when FuzzyMatch's own cap is what bites", async () => {
    // `width` is limit × 5, and FuzzyMatch returns at most 100 hits per call.
    // At limit 25 the width is 125, so "did we get width hits back?" could
    // never be true: the shortlist lost everything past the hundredth name and
    // the result said nothing had been truncated. The flag now comes from the
    // ranker, which is the only place that knows.
    //
    // 110 entries, not 200, so the WHOLE-STRING cap is the only one that can
    // bite: the token pass shortlists all 110, under the width of 125, and so
    // reports nothing. At 200 the token pass truncated too and this test
    // passed with the whole-string cap silently broken — which is the same
    // vacuous-guard trap it is here to catch.
    const crowd = Array.from({ length: 110 }, (_, i) => ({
      id: `E-${String(i).padStart(3, "0")}`,
      name: `Ivan Ivanov ${String(i).padStart(3, "0")}`,
      kind: "person" as const,
    }));
    const result = await screenSubjects(
      [{ id: "s1", name: "Ivan Ivanov", kind: "person" }],
      [snapshot({ entries: crowd })],
      [1],
      { ...policy, limit: 25 },
      NOW,
    );
    expect(result.subjects[0]?.prefilterTruncated).toBe(true);
  });

  test("a truncated shortlist with no candidates says so in the note, not only in a field", async () => {
    // "No name reached the threshold. That is not a clearance." is the
    // sentence an operator acts on. Beside a separate boolean it still reads
    // as clean to anybody who reads the note — which is everybody — so the
    // hole goes in the note.
    const crowd = Array.from({ length: 300 }, (_, i) => ({
      id: `E-${String(i).padStart(3, "0")}`,
      name: `Ivan Ivanov ${String(i).padStart(3, "0")}`,
      kind: "person" as const,
    }));
    const result = await screenSubjects(
      [{ id: "s1", name: "Ivan Ivanov", kind: "person" }],
      [snapshot({ entries: crowd })],
      [1],
      policy,
      NOW,
    );
    const subject = result.subjects[0];
    expect(subject?.candidates).toEqual([]);
    expect(subject?.prefilterTruncated).toBe(true);
    expect(subject?.note).toContain("not the whole list");
  });
});

// ---------------------------------------------------------------------------

describe("the network floor", () => {
  test("a URL outside the four constant origins is refused before it is dialled", async () => {
    // Nothing in this package builds such a URL, which is exactly why this is
    // asserted: it is the check that turns a bug in a path template into a
    // refusal rather than into a request somewhere else.
    expect(getJson("https://evil.example/lei-records/x")).rejects.toThrow(KycNetworkError);
    expect(getJson("not a url at all")).rejects.toThrow(KycNetworkError);
  });

  test("a body over the cap is truncated rather than parsed from a prefix", async () => {
    // Half a document parses into a shorter, plausible, WRONG answer — a
    // register record with the fields that happened to arrive first.
    const body = JSON.stringify({ padding: "x".repeat(2_000) });
    const capped = await readCapped(new Response(body), 256);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe("");
  });

  test("a body inside the cap comes back whole", async () => {
    const capped = await readCapped(new Response('{"ok":1}'), 1_024);
    expect({ truncated: capped.truncated, text: capped.text }).toEqual({
      truncated: false,
      text: '{"ok":1}',
    });
  });
});
