/**
 * Who a `crewhaus review` verb resolves an entry as: the local user as the harness's
 * records hold one (a member's id when their access records link one, else a keyed
 * digest), through the CLI. A harness whose digest key cannot be read names nobody: the
 * verdict is recorded either way.
 */
import { localStoredActor, qualityControl } from "./quality-receipts";
import type { ReviewActor } from "./review-queue";

export async function localReviewActor(root: string): Promise<ReviewActor | undefined> {
  try {
    return { by: await localStoredActor(root, qualityControl()), via: "cli" };
  } catch {
    return undefined;
  }
}

/** The line printed when another resolver took the entry first. */
export function alreadyTakenLine(
  id: string,
  winner: { readonly by?: string; readonly via?: string; readonly at: string } | undefined,
): string {
  const where = winner?.via !== undefined ? ` from ${winner.via}` : "";
  const when = winner !== undefined ? ` at ${winner.at}` : "";
  return `review item ${id} was already resolved${where}${when}\n`;
}
