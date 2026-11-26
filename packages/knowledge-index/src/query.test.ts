import { describe, expect, test } from "bun:test";
import { type ParsedQuery, kindsOf, parseQuery } from "./query";

const plain = (over: Partial<ParsedQuery> = {}): ParsedQuery => ({
  words: "",
  kinds: [],
  inHarnesses: [],
  tags: [],
  statuses: [],
  ...over,
});

describe("parseQuery", () => {
  const table: readonly (readonly [string, ParsedQuery])[] = [
    ["", plain()],
    ["   ", plain()],
    ["refund policy", plain({ words: "refund policy" })],
    ["type:fact refund", plain({ words: "refund", kinds: ["facts", "shared"] })],
    ["type:facts", plain({ kinds: ["facts", "shared"] })],
    ["TYPE:Wiki billing", plain({ words: "billing", kinds: ["wiki"] })],
    ["type:work type:criterion", plain({ kinds: ["work", "criterion"] })],
    ["type:nonsense refund", plain({ words: "type:nonsense refund" })],
    [
      "in:support-assistant refunds",
      plain({ words: "refunds", inHarnesses: ["support-assistant"] }),
    ],
    ['in:"Support Bot" refunds', plain({ words: "refunds", inHarnesses: ["Support Bot"] })],
    ["#Billing refunds #vip", plain({ words: "refunds", tags: ["billing", "vip"] })],
    ["#", plain({ words: "#" })],
    ["since:7d", plain({ sinceDays: 7 })],
    ["since:0d", plain({ words: "since:0d" })],
    ["since:soon", plain({ words: "since:soon" })],
    ["since:99999d", plain({ words: "since:99999d" })],
    ["status:Corrected", plain({ statuses: ["corrected"] })],
    ["status:live status:draft", plain({ statuses: ["live", "draft"] })],
    ["facts about refunds", plain({ words: "refunds", kinds: ["facts", "shared"] })],
    ["Articles about the currency", plain({ words: "the currency", kinds: ["wiki"] })],
    ["everything about refunds", plain({ words: "everything about refunds" })],
    ["refunds last week", plain({ words: "refunds", sinceDays: 7 })],
    ["refunds last month since:3d", plain({ words: "refunds", sinceDays: 3 })],
    ["today yesterday", plain({ sinceDays: 1 })],
    [
      "facts about refunds last week #vip",
      plain({ words: "refunds", kinds: ["facts", "shared"], tags: ["vip"], sinceDays: 7 }),
    ],
    ['"exact words"', plain({ words: "exact words" })],
    ["http://example.com/a:b", plain({ words: "http://example.com/a:b" })],
    ["type: refund", plain({ words: "type: refund" })],
    ["__proto__ constructor", plain({ words: "__proto__ constructor" })],
    ["type:constructor", plain({ words: "type:constructor" })],
  ];
  for (const [q, expected] of table) {
    test(JSON.stringify(q), () => expect(parseQuery(q)).toEqual(expected));
  }

  test("the same words read the same way, every time", () => {
    for (const [q] of table) expect(parseQuery(q)).toEqual(parseQuery(q));
  });
});

describe("kindsOf", () => {
  test("names a kind by the words a person uses, and nothing else", () => {
    expect(kindsOf("memories")).toEqual(["facts", "shared"]);
    expect(kindsOf("Plans")).toEqual(["plans"]);
    expect(kindsOf("focus")).toEqual(["focus"]);
    expect(kindsOf("toString")).toBeUndefined();
    expect(kindsOf("")).toBeUndefined();
  });
});
