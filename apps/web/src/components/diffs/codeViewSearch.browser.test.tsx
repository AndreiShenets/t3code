import { CodeView } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { userEvent } from "vite-plus/test/browser";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useDiffSearchShortcut } from "./useDiffSearchShortcut";
import { useChatShortcuts } from "../chat/useChatShortcuts";
import { isPreviewFocused } from "~/lib/previewFocus";

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
let panel: HTMLDivElement;
let root: Root;

function Shortcuts() {
  useDiffSearchShortcut({ getInstance: () => viewer });
  return null;
}

function ChatShortcuts() {
  const [findOpen, setFindOpen] = useState(false);
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: isPreviewFocused(),
      previewOpen: true,
      modelPickerOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
    threadFindActive: findOpen,
    typeIntoComposer: () => false,
    closeThreadFind: () => setFindOpen(false),
    commands: { "chat.find": () => setFindOpen(true) },
    fallback: () => undefined,
  });
  return findOpen ? <div data-chat-find-open /> : null;
}

async function mountChatFirst() {
  panel.setAttribute("data-preview-panel-mode", "inline");
  await act(async () => root.render(<ChatShortcuts />));
  await act(async () =>
    root.render(
      <>
        <ChatShortcuts />
        <Shortcuts />
      </>,
    ),
  );
}

afterEach(async () => {
  await act(async () => root.unmount());
  viewer?.cleanUp();
  panel.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  panel = document.createElement("div");
  document.body.append(panel);
  scope = document.createElement("div");
  scope.setAttribute("data-diff-search-scope", "");
  panel.append(scope);
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

it("opens find in a standalone review before clicking a collapsed file", async () => {
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

it.each(["inline toolbar", "sheet toolbar", "Changes tab"])(
  "opens diff find from the %s with chat shortcuts registered first",
  async (entryPoint) => {
    await mountChatFirst();
    if (entryPoint === "sheet toolbar") panel.setAttribute("role", "dialog");
    const button = document.createElement("button");
    button.textContent = entryPoint;
    if (entryPoint === "Changes tab") panel.prepend(button);
    else scope.prepend(button);
    await userEvent.click(button);
    await userEvent.keyboard("{Control>}f{/Control}");
    expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
    expect(panel.querySelector("[data-chat-find-open]")).toBeNull();
    expect(viewer!.getItem("src/example.ts")?.collapsed).toBe(true);
  },
);

it("keeps chat find when the chat composer is focused", async () => {
  await mountChatFirst();
  const composer = document.createElement("textarea");
  document.body.append(composer);
  try {
    await userEvent.click(composer);
    await userEvent.keyboard("{Control>}f{/Control}");
    expect(panel.querySelector("[data-chat-find-open]")).not.toBeNull();
    expect(container!.querySelector("[data-diffs-search]")).toBeNull();
  } finally {
    composer.remove();
  }
});

it("does not claim page find just because a diff is visible beside chat", async () => {
  panel.setAttribute("data-preview-panel-mode", "inline");
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("keeps the viewer's own find and Escape behavior", async () => {
  await mountChatFirst();
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

it("does not take find from a separate dialog inside the panel", async () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const button = document.createElement("button");
  button.textContent = "Confirm";
  dialog.append(button);
  scope.append(dialog);
  await userEvent.click(button);
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
