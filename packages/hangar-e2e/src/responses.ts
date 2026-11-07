/**
 * Everything a browser received: every response's headers and body, from before
 * sign-in on. For a check that something never reaches the browser, where a read
 * that quietly came back empty would pass for proof.
 */
import type { Response } from "playwright";

export type ReceivedResponse = {
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Undefined if no body could be read; `unread` says whether that is a problem. */
  readonly body: string | undefined;
};

/** How long one body gets. The browser may never finish one the page never read. */
const BODY_BOUND_MS = 5_000;

const isStream = (headers: Readonly<Record<string, string>>): boolean =>
  headers["content-type"]?.includes("text/event-stream") === true;

/** Keep what each response brings. A live event stream has no end to wait for, so its body stays unread. */
export function responseRecorder(): {
  readonly observe: (response: Response) => void;
  readonly received: () => Promise<readonly ReceivedResponse[]>;
} {
  const pending: Array<Promise<ReceivedResponse>> = [];
  return {
    observe: (response) => {
      pending.push(
        (async () => {
          const headers = await response.allHeaders();
          const body = isStream(headers)
            ? undefined
            : await Promise.race([
                response.text().catch(() => undefined),
                Bun.sleep(BODY_BOUND_MS).then(() => undefined),
              ]);
          return {
            path: new URL(response.url()).pathname,
            status: response.status(),
            headers,
            body,
          };
        })(),
      );
    },
    received: () => Promise.all(pending),
  };
}

/** Each place a value appears in what was received. */
export function whereReceived(responses: readonly ReceivedResponse[], value: string): string[] {
  const places: string[] = [];
  for (const { path, headers, body } of responses) {
    for (const [name, content] of Object.entries(headers)) {
      if (name.includes(value) || content.includes(value)) places.push(`${name} header of ${path}`);
    }
    if (body?.includes(value) === true) places.push(`body of ${path}`);
  }
  return places;
}

/**
 * The responses whose body should have been read and was not. A redirect or an
 * empty answer has none to read. A live event stream has one that cannot be read
 * to its end, so it is named too: a check that sees one has to decide about it.
 */
export function unreadResponses(responses: readonly ReceivedResponse[]): readonly string[] {
  return responses
    .filter(
      ({ status, body }) =>
        body === undefined && !(status >= 300 && status < 400) && status !== 204,
    )
    .map(({ path, status, headers }) =>
      isStream(headers) ? `a live stream from ${path}` : `${status} from ${path}`,
    );
}
