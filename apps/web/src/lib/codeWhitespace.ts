/** Backgrounds mark the original whitespace without adding text to selection or copy. */
export const CODE_WHITESPACE_UNSAFE_CSS = `
[data-code-whitespace="space"] {
  background-image: radial-gradient(circle, color-mix(in srgb, var(--diffs-fg) 40%, transparent) 1px, transparent 1px);
  background-size: 1ch 100%;
}
[data-code-whitespace="tab"] {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='12' viewBox='0 0 8 12'%3E%3Cpath d='M0 6h6M3 3l3 3-3 3' fill='none' stroke='%23888' stroke-opacity='.7'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: left center;
  background-size: 1ch 1em;
}
`;

const decoratedContainers = new WeakSet<HTMLElement>();
const renderers = new WeakMap<HTMLElement, ReturnType<typeof createWhitespaceRenderer>>();

export function releaseCodeWhitespace(container: HTMLElement): void {
  renderers.get(container)?.release();
  renderers.delete(container);
}

/** Decorate only mounted code lines; gutters, comments and hidden source stay untouched. */
export function renderCodeWhitespace(container: HTMLElement, enabled: boolean): void {
  const root = container.shadowRoot;
  if (root === null) return;
  let renderer = renderers.get(container);
  if (renderer === undefined) {
    renderer = createWhitespaceRenderer(container, root);
    renderers.set(container, renderer);
  }
  renderer.render(enabled);
}

function createWhitespaceRenderer(container: HTMLElement, root: ShadowRoot) {
  let enabled = false;
  let composing = false;
  let compositionVersion = 0;
  let released = false;
  // Inline editing and deferred tokenization replace line children without a
  // File post-render callback. Observe only while enabled, and repaint only the
  // affected lines. Disconnect around our own writes to avoid observer loops.
  const observer = new MutationObserver((mutations) => {
    if (!enabled || composing || released) return;
    const lines = new Set<Element>();
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const line = target?.closest("[data-line]");
      if (line) lines.add(line);
      for (const added of mutation.addedNodes) {
        if (!(added instanceof Element)) continue;
        if (added.matches("[data-line]")) lines.add(added);
        for (const child of added.querySelectorAll("[data-line]")) lines.add(child);
      }
    }
    if (lines.size === 0) return;
    observer.disconnect();
    preserveSelection(root, () => {
      for (const line of lines) if (root.contains(line)) decorateLine(line, true);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
  });
  const paint = (changed = false) => {
    if (composing || released) return;
    observer.disconnect();
    if (!enabled) {
      if (decoratedContainers.delete(container)) preserveSelection(root, () => removeMarkers(root));
      return;
    }
    decoratedContainers.add(container);
    preserveSelection(root, () => {
      for (const line of root.querySelectorAll("[data-line]")) decorateLine(line, changed);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
  };
  const onCompositionStart = () => {
    composing = true;
    compositionVersion += 1;
    observer.disconnect();
  };
  const onCompositionEnd = () => {
    const version = compositionVersion;
    // Let Pierre commit the composition before replacing any composing text.
    queueMicrotask(() => {
      if (version !== compositionVersion || released) return;
      composing = false;
      paint(true);
    });
  };
  // Track composition even while markers are off so enabling them mid-composition
  // cannot replace the native input node. Explicit renders defer toggles too.
  root.addEventListener("compositionstart", onCompositionStart, true);
  root.addEventListener("compositionend", onCompositionEnd, true);
  return {
    render(nextEnabled: boolean) {
      enabled = nextEnabled;
      paint();
    },
    release() {
      released = true;
      observer.disconnect();
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
    },
  };
}

function removeMarkers(root: ParentNode) {
  for (const marker of root.querySelectorAll(
    "[data-code-whitespace], [data-code-whitespace-token]",
  )) {
    marker.replaceWith(...marker.childNodes);
  }
}

function decorateLine(line: Element, changed = false) {
  if (changed) removeMarkers(line);
  if (!/[ \t]/.test(line.textContent ?? "")) return;
  const document = line.ownerDocument;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let offset = 0;
  for (const node of nodes) {
    const text = node.textContent ?? "";
    if (node.parentElement?.closest("[data-code-whitespace]")) {
      offset += text.length;
      continue;
    }
    // Pierre locates editable selections through token offsets. Plain-text and
    // whitespace-only lines have no tokens until we wrap them, so supply their
    // original character offsets too, including non-whitespace text fragments.
    if (!node.parentElement?.closest("[data-char]")) {
      const token = document.createElement("span");
      token.dataset.codeWhitespaceToken = "";
      token.dataset.char = String(offset);
      node.parentNode?.replaceChild(token, node);
      token.append(node);
    }
    offset += text.length;
    if (/[ \t]/.test(text)) {
      const fragment = document.createDocumentFragment();
      for (const part of text.split(/( +|\t)/)) {
        if (!part) continue;
        if (part[0] === " " || part === "\t") {
          const marker = document.createElement("span");
          marker.dataset.codeWhitespace = part === "\t" ? "tab" : "space";
          marker.textContent = part;
          fragment.append(marker);
        } else {
          fragment.append(document.createTextNode(part));
        }
      }
      node.parentNode?.replaceChild(fragment, node);
    }
  }
}

/** Keep the native caret/selection anchored to source characters when wrapping text. */
function preserveSelection(root: ShadowRoot, update: () => void) {
  const selection =
    "getSelection" in root && typeof root.getSelection === "function"
      ? (root.getSelection() as Selection | null)
      : root.ownerDocument.getSelection();
  const snapshot = (node: Node | null, offset: number) => {
    if (node === null || !root.contains(node)) return null;
    const line = (node instanceof Element ? node : node.parentElement)?.closest("[data-line]");
    if (!line) return { node, offset, line: null };
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(line);
    range.setEnd(node, offset);
    return { node, offset: range.toString().length, line };
  };
  const anchor = snapshot(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  const focus = snapshot(selection?.focusNode ?? null, selection?.focusOffset ?? 0);
  update();
  if (!selection || !anchor || !focus || (!anchor.line && !focus.line)) return;
  const locate = (point: NonNullable<typeof anchor>) => {
    if (!point.line) return point;
    const walker = root.ownerDocument.createTreeWalker(point.line, NodeFilter.SHOW_TEXT);
    let offset = point.offset;
    while (walker.nextNode()) {
      const length = walker.currentNode.textContent?.length ?? 0;
      if (offset <= length) return { node: walker.currentNode, offset };
      offset -= length;
    }
    return { node: point.line, offset: point.line.childNodes.length };
  };
  const start = locate(anchor);
  const end = locate(focus);
  if (
    selection.anchorNode === start.node &&
    selection.anchorOffset === start.offset &&
    selection.focusNode === end.node &&
    selection.focusOffset === end.offset
  )
    return;
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
}
