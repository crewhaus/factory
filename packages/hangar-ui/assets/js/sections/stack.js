/**
 * A fresh container under `root` for the second view of a stacked pair (the
 * Spec editor under the Spec, the eval lab under the results). Every view
 * clears the root it is handed, so the second one gets a root of its own.
 * Built from the root's own document, so the section tables need nothing
 * that draws.
 */

export function stack(root) {
  const node = root.ownerDocument.createElement("div");
  node.className = "tab-section";
  root.appendChild(node);
  return node;
}
