import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveUsageShortcut } from "./usageShortcuts";

class TestElement extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {
    super();
  }

  closest() {
    return null;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Usage shortcuts while typing", () => {
  it("selects Today without changing the existing 24-hour shortcut", () => {
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("navigator", { platform: "Linux" });
    const event = {
      key: "0",
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      target: new TestElement("BODY"),
    };

    expect(resolveUsageShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS)).toBe("usage.period.today");
    expect(resolveUsageShortcut({ ...event, key: "1" }, DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "usage.period.day",
    );
  });

  it.each([new TestElement("INPUT"), new TestElement("TEXTAREA"), new TestElement("DIV", true)])(
    "leaves letters to the focused $tagName field",
    (target) => {
      vi.stubGlobal("HTMLElement", TestElement);
      vi.stubGlobal("navigator", { platform: "Linux" });
      const event = {
        key: "t",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target,
      };

      expect(resolveUsageShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
      expect(
        resolveUsageShortcut(
          { ...event, target: new TestElement("BODY") },
          DEFAULT_RESOLVED_KEYBINDINGS,
        ),
      ).toBe("usage.tokens");
    },
  );
});
