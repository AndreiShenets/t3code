import type { CodeView } from "@pierre/diffs";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useEffect } from "react";
import { isCommandPaletteOpen } from "~/commandPaletteBus";

export function useDiffSearchShortcut(
  viewer: {
    getInstance(): Pick<CodeView, "getContainerElement" | "openSearch"> | undefined;
  } | null,
) {
  useEffect(() => {
    const instance = viewer?.getInstance();
    const container = instance?.getContainerElement();
    if (!instance || !container) return;
    const scope = container.closest("[data-diff-search-scope]") ?? container;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.shiftKey ||
        !(isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey) ||
        (event.key.toLowerCase() !== "f" && event.code !== "KeyF") ||
        isCommandPaletteOpen()
      )
        return;

      const target = event.target;
      // Keep the viewer's own search/editor shortcuts, and other panes' find, untouched.
      if (
        !(target instanceof Element) ||
        container.contains(target) ||
        (target !== document.body && !scope.contains(target)) ||
        target.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]',
        ) ||
        !container.checkVisibility({ visibilityProperty: true })
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      instance.openSearch();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [viewer]);
}
