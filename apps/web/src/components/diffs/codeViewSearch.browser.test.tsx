import { CodeView } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { userEvent } from "vite-plus/test/browser";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useDiffSearchShortcut } from "./useDiffSearchShortcut";

const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-const before = 1;
+const after = 2;
`;

let viewer: CodeView | undefined;
let container: HTMLDivElement | undefined;
let scope: HTMLDivElement;
let root: Root;

function Shortcuts() {
  useDiffSearchShortcut({ getInstance: () => viewer });
  return null;
}

afterEach(async () => {
  await act(async () => root.unmount());
  viewer?.cleanUp();
  scope.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  scope = document.createElement("div");
  scope.setAttribute("data-diff-search-scope", "");
  document.body.append(scope);
  container = document.createElement("div");
  container.style.cssText = "width: 640px; height: 400px; overflow: auto";
  scope.append(container);
  viewer = new CodeView();
  viewer.setItems(
    parsePatchFiles(patch)[0]!.files.map((fileDiff) => ({
      type: "diff",
      id: fileDiff.name,
      fileDiff,
      collapsed: true,
    })),
  );
  viewer.setup(container);
  const host = document.createElement("div");
  scope.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Shortcuts />));
});

it("opens find with every file collapsed before clicking a file", async () => {
  await userEvent.keyboard("{Control>}f{/Control}");

  const search = container!.querySelector("[data-diffs-search]")?.shadowRoot;
  expect(search).toBeDefined();
  await userEvent.type(
    search!.querySelector<HTMLInputElement>('input[placeholder="Search"]')!,
    "src/",
  );
  await vi.waitFor(() =>
    expect(search!.querySelector("[data-matches]")?.textContent).toBe("1 of 1"),
  );
  expect(viewer!.getItem("src/example.ts")?.collapsed).toBe(true);
});

it("opens find with Command+F on macOS", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  await userEvent.keyboard("{Meta>}f{/Meta}");
  expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
});

it("opens find from the review toolbar without opening a file", async () => {
  const button = document.createElement("button");
  button.textContent = "Collapse all files";
  scope.prepend(button);
  await userEvent.click(button);
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
  expect(viewer!.getItem("src/example.ts")?.collapsed).toBe(true);
});

it("keeps the viewer's own find and Escape behavior", async () => {
  await userEvent.click(container!, { position: { x: 320, y: 200 } });
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it.each(["hidden", "invisible"])("ignores a %s review tab", async (visibility) => {
  if (visibility === "hidden") scope.style.display = "none";
  else scope.style.visibility = "hidden";
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("does not take find from a comment input", async () => {
  const input = document.createElement("textarea");
  scope.prepend(input);
  await userEvent.click(input);
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("does not take find from another pane", async () => {
  const button = document.createElement("button");
  button.textContent = "Other pane";
  document.body.append(button);
  try {
    await userEvent.click(button);
    await userEvent.keyboard("{Control>}f{/Control}");
    expect(container!.querySelector("[data-diffs-search]")).toBeNull();
  } finally {
    button.remove();
  }
});

it("leaves project-wide search alone", async () => {
  await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("removes the shortcut listener on unmount", async () => {
  await act(async () => root.render(null));
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});
