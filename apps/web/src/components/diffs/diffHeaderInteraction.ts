export function diffHeaderTogglePath(event: Event): string | null {
  // Pierre's headers live in a shadow root; event.target only identifies the host.
  const path = event.composedPath();
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (
      node instanceof HTMLButtonElement ||
      node instanceof HTMLAnchorElement ||
      node.hasAttribute("data-title") ||
      node.hasAttribute("data-prev-name") ||
      node.hasAttribute("data-viewed-toggle")
    ) {
      return null;
    }
    if (node.hasAttribute("data-diffs-header")) {
      return node.querySelector("[data-title]")?.textContent?.trim() || null;
    }
  }
  return null;
}
