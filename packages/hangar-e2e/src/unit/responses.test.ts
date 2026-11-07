import { describe, expect, test } from "bun:test";
import { type ReceivedResponse, unreadResponses, whereReceived } from "../responses";

const response = (over: Partial<ReceivedResponse>): ReceivedResponse => ({
  path: "/api/harnesses",
  status: 200,
  headers: { "content-type": "application/json" },
  body: "{}",
  ...over,
});

describe("whereReceived", () => {
  test("finds a value in a body, a header's value and a header's name, naming each", () => {
    const found = whereReceived(
      [
        response({ body: '{"key":"needle"}' }),
        response({ path: "/", headers: { "x-echo": "a needle here" }, body: "<html>" }),
        response({ path: "/assets/a.js", headers: { "x-needle": "1" }, body: "" }),
      ],
      "needle",
    );
    expect(found).toEqual([
      "body of /api/harnesses",
      "x-echo header of /",
      "x-needle header of /assets/a.js",
    ]);
  });

  test("a value nowhere is nowhere", () => {
    expect(whereReceived([response({}), response({ body: undefined })], "needle")).toEqual([]);
  });
});

describe("unreadResponses", () => {
  test("a body that should have come and did not is named", () => {
    expect(unreadResponses([response({ body: undefined })])).toEqual(["200 from /api/harnesses"]);
    expect(unreadResponses([response({ status: 404, body: undefined })])).toEqual([
      "404 from /api/harnesses",
    ]);
  });

  test("a redirect, an empty answer and a read body are fine", () => {
    expect(
      unreadResponses([
        response({ status: 302, body: undefined }),
        response({ status: 204, body: undefined }),
        response({}),
      ]),
    ).toEqual([]);
  });

  test("a live event stream cannot be read to its end, so it is named too", () => {
    const stream = response({ headers: { "content-type": "text/event-stream" }, body: undefined });
    expect(unreadResponses([stream])).toEqual(["a live stream from /api/harnesses"]);
  });
});
