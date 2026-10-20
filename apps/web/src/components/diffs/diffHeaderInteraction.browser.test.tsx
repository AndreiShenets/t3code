import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "../ui/tooltip";
import { DiffFileHeaderActions } from "./DiffFileHeaderActions";
import { diffHeaderTogglePath } from "./diffHeaderInteraction";

describe("diff file header interactions across the shadow boundary", () => {
  let container: HTMLDivElement;
  let shadow: ShadowRoot;
  let root: Root;
  const toggle = vi.fn();
  const open = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    toggle.mockClear();
    open.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    shadow = container.attachShadow({ mode: "open" });
    container.addEventListener(
      "click",
      (event) => {
        const path = diffHeaderTogglePath(event);
        if (path !== null) toggle(path);
      },
      true,
    );
    root = createRoot(shadow);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <div data-diffs-header>
            <button aria-label="Collapse diff" onClick={() => toggle("src/new.ts")}>
              Chevron
            </button>
            <span data-prev-name>
              <span>src/old.ts</span>
            </span>
            <span data-title>
              <span>src/new.ts</span>
            </span>
            <DiffFileHeaderActions filePath="src/new.ts" onOpenFile={open} />
            <label data-viewed-toggle>
              <input type="checkbox" />
              Viewed
            </label>
            <span data-stat>+1 -1</span>
          </div>
          <div data-body>Code</div>
        </TooltipProvider>,
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function click(selector: string) {
    const target = shadow.querySelector<HTMLElement>(selector);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
  }

  it("leaves both names inert, including their nested text", async () => {
    await click("[data-title] span");
    await click("[data-prev-name] span");
    expect(toggle).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("toggles the header outside the name and toggles the chevron only once", async () => {
    await click("[data-stat]");
    expect(toggle.mock.calls).toEqual([["src/new.ts"]]);
    await click('[aria-label="Collapse diff"]');
    expect(toggle.mock.calls).toEqual([["src/new.ts"], ["src/new.ts"]]);
  });

  it("opens the file without collapsing its diff", async () => {
    await click('[aria-label="Open file"]');
    expect(open).toHaveBeenCalledExactlyOnceWith("src/new.ts");
    expect(toggle).not.toHaveBeenCalled();
  });

  it("copies the path without opening or collapsing the file", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await click('[aria-label="Copy file path"]');
    expect(write).toHaveBeenCalledExactlyOnceWith("src/new.ts");
    expect(toggle).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves viewed toggles and the code body alone", async () => {
    await click("[data-viewed-toggle] input");
    await click("[data-body]");
    expect(shadow.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
