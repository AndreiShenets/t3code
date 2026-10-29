import { CodeView } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
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

function Shortcuts({ viewer }: { viewer: CodeView }) {
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
    composerRef: { current: null },
    branchToolbarRef: { current: null },
    closeThreadFind: () => setFindOpen(false),
    commands: { "chat.find": () => setFindOpen(true) },
    fallback: () => undefined,
  });
  return findOpen ? <div data-chat-find-open /> : null;
}

async function setup({ chatFirst = false, platform = "Win32" } = {}) {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue(platform));
  const panel = document.createElement("div");
  stack.defer(() => panel.remove());
  document.body.append(panel);
  const scope = document.createElement("div");
  scope.setAttribute("data-diff-search-scope", "");
  panel.append(scope);
  const container = document.createElement("div");
  container.style.cssText = "width: 640px; height: 400px; overflow: auto";
  scope.append(container);
  const viewer = new CodeView();
  stack.defer(() => viewer.cleanUp());
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
  if (chatFirst) panel.setAttribute("data-preview-panel-mode", "inline");
  const screen = stack.use(
    await render(chatFirst ? <ChatShortcuts /> : <Shortcuts viewer={viewer} />, {
      container: host,
    }),
  );
  if (chatFirst) {
    await screen.rerender(
      <>
        <ChatShortcuts />
        <Shortcuts viewer={viewer} />
      </>,
    );
  }
  const environment = stack.move();
  return {
    viewer,
    container,
    scope,
    panel,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

it.each([
  ["Win32", "Control"],
  ["MacIntel", "Meta"],
])("opens find from a standalone %s review before clicking a file", async (platform, modifier) => {
  await using screen = await setup({ platform });
  const { container, viewer } = screen;
  await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);
  expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
  expect(viewer!.getItem("src/example.ts")?.collapsed).toBe(true);
});

it.each(["inline toolbar", "sheet toolbar", "Changes tab"])(
  "opens diff find from the %s with chat shortcuts registered first",
  async (entryPoint) => {
    await using screen = await setup({ chatFirst: true });
    const { panel, scope, container, viewer } = screen;
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

it("does not claim page find just because a diff is visible beside chat", async () => {
  await using screen = await setup();
  const { panel, container } = screen;
  panel.setAttribute("data-preview-panel-mode", "inline");
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("leaves find owned by the focused viewer rather than chat", async () => {
  await using screen = await setup({ chatFirst: true });
  const { panel, container } = screen;
  await userEvent.click(container!, { position: { x: 320, y: 200 } });
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
  expect(panel.querySelector("[data-chat-find-open]")).toBeNull();
});

it.each(["inline", "standalone", "sheet"])(
  "opens review find after clicking non-focusable %s chrome beside collapsed files",
  async (mode) => {
    await using screen = await setup({ chatFirst: true });
    const { panel, scope, container, viewer } = screen;
    if (mode === "standalone") panel.removeAttribute("data-preview-panel-mode");
    if (mode === "sheet") panel.setAttribute("role", "dialog");
    const composer = document.createElement("textarea");
    document.body.append(composer);
    const chrome = document.createElement("div");
    chrome.textContent = "Review files";
    scope.prepend(chrome);
    try {
      await userEvent.click(composer);
      await userEvent.click(chrome);
      await userEvent.keyboard("{Control>}f{/Control}");
      expect(container!.querySelector("[data-diffs-search]")).not.toBeNull();
      expect(panel.querySelector("[data-chat-find-open]")).toBeNull();
      expect(viewer!.getItem("src/example.ts")?.collapsed).toBe(true);

      await userEvent.keyboard("{Escape}");
      await userEvent.click(composer);
      await userEvent.keyboard("{Control>}f{/Control}");
      expect(container!.querySelector("[data-diffs-search]")).toBeNull();
      expect(panel.querySelector("[data-chat-find-open]")).not.toBeNull();
    } finally {
      composer.remove();
    }
  },
);

it.each(["hidden", "invisible"])("ignores a %s review tab", async (visibility) => {
  await using screen = await setup();
  const { scope, container } = screen;
  if (visibility === "hidden") scope.style.display = "none";
  else scope.style.visibility = "hidden";
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("does not take find from a comment input", async () => {
  await using screen = await setup();
  const { scope, container } = screen;
  const input = document.createElement("textarea");
  scope.prepend(input);
  await userEvent.click(input);
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});

it("does not take find from a separate dialog inside the panel", async () => {
  await using screen = await setup();
  const { scope, container } = screen;
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
  await using screen = await setup();
  const { container } = screen;
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
  await using screen = await setup();
  const { container } = screen;
  await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(container!.querySelector("[data-diffs-search]")).toBeNull();
});
