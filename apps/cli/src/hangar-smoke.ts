/**
 * Checks `hangar serve --smoke` runs against a booted console, beside the ones in
 * hangar-cmd.ts. The console's files are embedded in the compiled binary (text
 * imports), so only a run of that binary can prove each one made it in; a smoke that
 * fetched the shell alone passed with a script or stylesheet missing.
 *
 * A check here takes the smoke's own `get` and returns its verdict; the caller turns
 * a failure into the `✗` line. More of the console's self-checks join this module.
 */

/** One embedded file as the asset map holds it. */
export type EmbeddedAsset = { readonly body: string; readonly contentType: string };

/** How many problems a failure lists before it says how many more there are. */
const LISTED = 5;

/**
 * Every key of the embedded asset map must serve with status 200, a `content-type`
 * equal to the asset's own, and exactly the asset's body length in bytes. Problems
 * name the key. An empty map is a problem too: zero files checked proves nothing.
 */
export async function assetSmokeCheck(
  get: (path: string) => Promise<Response>,
  assets: Readonly<Record<string, EmbeddedAsset>>,
): Promise<{ ok: true; count: number } | { ok: false; problems: string[] }> {
  const keys = Object.keys(assets);
  if (keys.length === 0) return { ok: false, problems: ["no embedded console files to check"] };
  const problems: string[] = [];
  for (const key of keys) {
    const asset = assets[key] as EmbeddedAsset;
    let res: Response;
    try {
      res = await get(key);
    } catch (err) {
      problems.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const bytes = (await res.arrayBuffer()).byteLength;
    if (res.status !== 200) {
      problems.push(`${key}: status ${res.status}`);
      continue;
    }
    const type = res.headers.get("content-type");
    if (type !== asset.contentType) {
      problems.push(`${key}: content-type ${type ?? "(none)"}, expected ${asset.contentType}`);
    }
    const expected = Buffer.byteLength(asset.body);
    if (bytes !== expected) problems.push(`${key}: ${bytes} bytes, expected ${expected}`);
  }
  return problems.length === 0 ? { ok: true, count: keys.length } : { ok: false, problems };
}

/** A failed check's problems as one line: the first few, then how many more. */
export function problemSummary(problems: readonly string[]): string {
  const shown = problems.slice(0, LISTED).join("; ");
  return problems.length > LISTED ? `${shown}; and ${problems.length - LISTED} more` : shown;
}
