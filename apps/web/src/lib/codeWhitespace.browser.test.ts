import { describe, expect, it } from "vite-plus/test";

import { releaseCodeWhitespace, renderCodeWhitespace } from "./codeWhitespace";

function codeContainer() {
  const container = document.createElement("div");
  const root = container.attachShadow({ mode: "open" });
  root.innerHTML =
    '<div data-column-number>1</div><div data-line><span>\tconst </span><span>name</span><span> = "a b"; \t\t</span></div><div data-line-annotation>A comment with spaces</div>';
  return {
    container,
    root,
    line: root.querySelector("[data-line]")!,
    [Symbol.dispose]() {
      releaseCodeWhitespace(container);
      container.remove();
    },
  };
}

describe("display-only whitespace markers", () => {
  it("keeps copied text and token boundaries while distinguishing spaces from tabs", () => {
    using host = codeContainer();
    const { container, root, line } = host;
    const original = line.textContent;
    const tokens = [...line.children];
    renderCodeWhitespace(container, true);

    const selection = document.createRange();
    selection.selectNodeContents(line);
    expect(selection.toString()).toBe(original);
    expect([...line.children]).toEqual(tokens);
    expect(root.querySelectorAll('[data-code-whitespace="tab"]')).toHaveLength(3);
    expect(
      [...root.querySelectorAll('[data-code-whitespace="space"]')]
        .map((node) => node.textContent)
        .join(""),
    ).toBe("     ");
    expect(root.querySelector("[data-line-annotation]")?.innerHTML).toBe("A comment with spaces");
    expect(root.querySelector("[data-column-number]")?.innerHTML).toBe("1");
  });

  it("handles repeated virtualized renders and new lines without nesting markers", () => {
    using host = codeContainer();
    const { container, root, line } = host;
    const original = line.textContent;
    renderCodeWhitespace(container, true);
    const count = root.querySelectorAll("[data-code-whitespace]").length;
    renderCodeWhitespace(container, true);
    expect(root.querySelectorAll("[data-code-whitespace]")).toHaveLength(count);
    expect(root.querySelector("[data-code-whitespace] [data-code-whitespace]")).toBeNull();

    line.innerHTML = "<span>\tnew value  </span>";
    renderCodeWhitespace(container, true);
    expect(line.textContent).toBe("\tnew value  ");
    expect(root.querySelectorAll('[data-code-whitespace="tab"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-code-whitespace="space"]')).toHaveLength(2);

    line.textContent = original;
    renderCodeWhitespace(container, true);
    expect(line.textContent).toBe(original);
  });

  it("removes markers when disabled and can enable them again without changing source", () => {
    using host = codeContainer();
    const { container, root, line } = host;
    const original = line.textContent;
    renderCodeWhitespace(container, false);
    expect(root.querySelector("[data-code-whitespace]")).toBeNull();
    renderCodeWhitespace(container, true);
    renderCodeWhitespace(container, false);
    expect(root.querySelector("[data-code-whitespace]")).toBeNull();
    expect(line.textContent).toBe(original);
    renderCodeWhitespace(container, true);
    expect(root.querySelector('[data-code-whitespace="tab"]')).not.toBeNull();
    expect(line.textContent).toBe(original);
  });

  it("preserves composing text through mutations and renders, then resumes decoration", async () => {
    using host = codeContainer();
    const { container, root, line } = host;
    renderCodeWhitespace(container, true);
    const marker = line.querySelector('[data-code-whitespace="space"]')!;
    const composingText = marker.firstChild as Text;
    line.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composingText.data = " 日本 ";
    const expected = line.textContent;
    await Promise.resolve();
    renderCodeWhitespace(container, true);
    expect(marker.firstChild).toBe(composingText);
    expect(composingText.parentNode).toBe(marker);
    expect(line.contains(marker)).toBe(true);

    line.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    expect(line.textContent).toBe(expected);
    expect(line.contains(marker)).toBe(false);
    expect(
      [...line.querySelectorAll("[data-code-whitespace]")].every((node) =>
        /^[ \t]+$/.test(node.textContent ?? ""),
      ),
    ).toBe(true);

    line.textContent = "new value\t";
    await Promise.resolve();
    expect(root.querySelector('[data-code-whitespace="tab"]')?.textContent).toBe("\t");
    expect(line.textContent).toBe("new value\t");
  });

  it.each([
    ["disabling", true, [false]],
    ["disabling and re-enabling", true, [false, true]],
    ["enabling", false, [true]],
    ["enabling and disabling", false, [true, false]],
  ] as const)("defers %s markers until composition finishes", async (_label, initial, toggles) => {
    using host = codeContainer();
    const { container, root, line } = host;
    line.textContent = " a b ";
    renderCodeWhitespace(container, initial);
    const composingText = (line.querySelector("[data-code-whitespace]")?.firstChild ??
      line.firstChild) as Text;
    const parent = composingText.parentNode;
    line.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composingText.data = " 日本 ";
    const expected = line.textContent;

    for (const enabled of toggles) {
      renderCodeWhitespace(container, enabled);
      await Promise.resolve();
      expect(composingText.parentNode).toBe(parent);
      expect(line.contains(composingText)).toBe(true);
      expect(line.textContent).toBe(expected);
    }

    line.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    expect(line.textContent).toBe(expected);
    expect(root.querySelector("[data-code-whitespace]") !== null).toBe(toggles.at(-1));
    if (!toggles.at(-1)) expect(root.querySelector("[data-code-whitespace-token]")).toBeNull();
  });

  it("defers renders from compositionend handlers and respects a new composition", async () => {
    using host = codeContainer();
    const { container, root, line } = host;
    renderCodeWhitespace(container, true);
    const marker = line.querySelector("[data-code-whitespace]")!;
    const composingText = marker.firstChild;
    line.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    line.addEventListener(
      "compositionend",
      () => {
        renderCodeWhitespace(container, false);
        expect(composingText?.parentNode).toBe(marker);
        expect(line.contains(marker)).toBe(true);
      },
      { once: true },
    );
    line.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    line.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await Promise.resolve();
    expect(composingText?.parentNode).toBe(marker);
    expect(line.contains(marker)).toBe(true);
    line.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    expect(root.querySelector("[data-code-whitespace]")).toBeNull();
  });

  it.each([false, true])(
    "stops composition repainting and observation on release (end first: %s)",
    async (endFirst) => {
      using host = codeContainer();
      const { container, root, line } = host;
      renderCodeWhitespace(container, true);
      line.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const end = () =>
        line.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      if (endFirst) end();
      releaseCodeWhitespace(container);
      if (!endFirst) end();
      line.textContent = " 日本 \t";
      const text = line.firstChild;
      await Promise.resolve();
      expect(line.firstChild).toBe(text);
      expect(root.querySelector("[data-code-whitespace]")).toBeNull();

      renderCodeWhitespace(container, true);
      expect(root.querySelector('[data-code-whitespace="tab"]')).not.toBeNull();
    },
  );
});
