import { describe, expect, test } from "bun:test";
import { consoleErrorReason } from "../session";

const FAILED = (status: string): string =>
  `Failed to load resource: the server responded with a status of ${status}`;

describe("consoleErrorReason", () => {
  test("an /api/* 404 is the client's contract: absence is not an error", () => {
    expect(consoleErrorReason(FAILED("404 (Not Found)"), "http://x/api/h/a/thing")).toBeNull();
  });

  test.each([
    ["an /api/* 500", FAILED("500 (Internal Server Error)"), "http://x/api/h/a"],
    ["an /api/* 401", FAILED("401 (Unauthorized)"), "http://x/api/h/a"],
    ["an /api/* 400", FAILED("400 (Bad Request)"), "http://x/api/h/a"],
    ["an /assets/* 404", FAILED("404 (Not Found)"), "http://x/assets/js/app.js"],
    ["a 404 elsewhere", FAILED("404 (Not Found)"), "http://x/favicon.ico"],
    ["a path that only contains /api/", FAILED("404 (Not Found)"), "http://x/not/api/a"],
    ["another message from the API", "Uncaught TypeError: x", "http://x/api/h/a"],
    ["a 404 at no location", FAILED("404 (Not Found)"), ""],
    ["a plain console.error", "something broke", "http://x/assets/js/app.js"],
  ])("%s is a failure, and says so", (_what, text, url) => {
    const reason = consoleErrorReason(text, url);
    expect(reason).toContain(text);
    expect(reason).toContain(url);
  });
});

describe("consoleErrorReason with the statuses a journey answers itself", () => {
  const expected = [
    { pathname: "/api/h/hrn_a/proc/start", status: 409 },
    { pathname: "/api/h/hrn_a/spec/patch", status: 412 },
  ];

  test("is excused for that path and that status only", () => {
    expect(
      consoleErrorReason(FAILED("409 (Conflict)"), "http://x/api/h/hrn_a/proc/start", expected),
    ).toBeNull();
    expect(
      consoleErrorReason(
        FAILED("412 (Precondition Failed)"),
        "http://x/api/h/hrn_a/spec/patch",
        expected,
      ),
    ).toBeNull();
  });

  test.each([
    ["another path", FAILED("409 (Conflict)"), "http://x/api/h/hrn_b/proc/start"],
    [
      "the same path with another status",
      FAILED("400 (Bad Request)"),
      "http://x/api/h/hrn_a/proc/start",
    ],
    [
      "a status swapped between paths",
      FAILED("412 (Precondition Failed)"),
      "http://x/api/h/hrn_a/proc/start",
    ],
    ["a longer path", FAILED("409 (Conflict)"), "http://x/api/h/hrn_a/proc/start/again"],
    ["another message on that path", "Uncaught TypeError: x", "http://x/api/h/hrn_a/proc/start"],
  ])("is still a failure for %s", (_what, text, url) => {
    expect(consoleErrorReason(text, url, expected)).toContain(text);
  });

  test("never excuses a 5xx, whatever the journey asked for", () => {
    const fiveHundred = [{ pathname: "/api/h/hrn_a/proc/start", status: 500 }];
    const text = FAILED("500 (Internal Server Error)");
    expect(consoleErrorReason(text, "http://x/api/h/hrn_a/proc/start", fiveHundred)).toContain(
      text,
    );
  });

  test("with none asked for, the default stays exactly as narrow as before", () => {
    expect(
      consoleErrorReason(FAILED("409 (Conflict)"), "http://x/api/h/hrn_a/proc/start"),
    ).toContain("409");
  });
});
