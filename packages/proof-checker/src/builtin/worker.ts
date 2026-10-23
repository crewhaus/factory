/**
 * The builtin checker's worker thread: one `checkCertificate` per check
 * (see ./runner for why a check runs on a thread of its own).
 *
 * Nothing imports this file. `scripts/gen-worker-source.ts` bundles it, with
 * the checker it imports, into the text in ./worker-source, and the runner
 * starts that text from a Blob URL. Edit it, or anything it imports, and
 * re-run the script: `worker-source.test.ts` fails until the text matches.
 *
 * Protocol (one check per worker; the runner terminates it afterwards):
 *   ← { kind: "ready" }                                 once, at start-up
 *   → { statement, proof, timeoutMs }
 *   ← { kind: "verdict", verdict: BuiltinVerdict }
 */
import { checkCertificate } from "./checker";

type Job = { readonly statement: string; readonly proof: string; readonly timeoutMs: number };

const thread = globalThis as unknown as {
  onmessage: ((event: { readonly data: Job }) => void) | null;
  postMessage(message: unknown): void;
};

thread.onmessage = (event) => {
  const { statement, proof, timeoutMs } = event.data;
  thread.postMessage({
    kind: "verdict",
    verdict: checkCertificate({ statement, proof, timeoutMs }),
  });
};

thread.postMessage({ kind: "ready" });
