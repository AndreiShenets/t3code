import {
  File,
  FileDiff,
  getSharedHighlighter,
  parseDiffFromFile,
  type PostRenderPhase,
} from "@pierre/diffs";
import { Editor, EditStateManager, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File as ReactFile } from "@pierre/diffs/react";
import { createElement, type CSSProperties } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

import {
  CODE_WHITESPACE_UNSAFE_CSS,
  releaseCodeWhitespace,
  renderCodeWhitespace,
} from "./codeWhitespace";
import { useEditorTabSize } from "../components/files/useEditorTabSize";

async function setup() {
  await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["typescript"] });
  const element = document.createElement("diffs-container");
  document.body.append(element);
  let enabled = true;
  return {
    element,
    [Symbol.dispose]() {
      releaseCodeWhitespace(element);
      element.remove();
    },
    root: element.shadowRoot!,
    setEnabled(value: boolean) {
      enabled = value;
    },
    options: {
      theme: "pierre-dark" as const,
      themeType: "dark" as const,
      disableErrorHandling: true,
      unsafeCSS: CODE_WHITESPACE_UNSAFE_CSS,
      onPostRender: (container: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
        if (phase === "unmount") releaseCodeWhitespace(container);
        else renderCodeWhitespace(container, enabled);
      },
    },
  };
}

function sourceLines(root: ShadowRoot) {
  return [...root.querySelectorAll("[data-line]")].map((line) => {
    const range = document.createRange();
    range.selectNodeContents(line);
    return range.toString();
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Pierre whitespace decoration", () => {
  it("preserves the source through highlighting, toggling and file replacement", async () => {
    using host = await setup();
    const { element, root, options, setEnabled } = host;
    const file = { name: "app.ts", contents: '\tconst name = "a b";\n \tname;\n' };
    const viewer = new File(options);
    try {
      viewer.render({ file, fileContainer: element });
      expect(sourceLines(root)).toEqual(['\tconst name = "a b";', " \tname;", "\n"]);
      expect(root.querySelector('[data-code-whitespace="space"]')).not.toBeNull();
      expect(root.querySelector('[data-code-whitespace="tab"]')).not.toBeNull();

      setEnabled(false);
      viewer.rerender();
      expect(root.querySelector("[data-code-whitespace]")).toBeNull();
      expect(sourceLines(root)).toEqual(['\tconst name = "a b";', " \tname;", "\n"]);
      expect(file.contents).toBe('\tconst name = "a b";\n \tname;\n');

      setEnabled(true);
      viewer.render({ file: { ...file, contents: "\tnewName;  \n" } });
      expect(sourceLines(root)).toEqual(["\tnewName;  ", "\n"]);
      expect(root.querySelector('[data-code-whitespace="tab"]')).not.toBeNull();
    } finally {
      viewer.cleanUp();
    }
  });

  it.each(["split", "unified"] as const)("preserves both sides of a %s diff", async (diffStyle) => {
    using host = await setup();
    const { element, root, options } = host;
    const oldFile = { name: "app.ts", contents: "\tconst a = 1; \n" };
    const newFile = { name: "app.ts", contents: " \tconst a = 2;\n" };
    const fileDiff = parseDiffFromFile(oldFile, newFile);
    const viewer = new FileDiff({ ...options, diffStyle });
    try {
      viewer.render({ fileDiff, fileContainer: element });
      expect(sourceLines(root)).toEqual(["\tconst a = 1; ", " \tconst a = 2;"]);
      expect(root.querySelectorAll('[data-code-whitespace="tab"]')).toHaveLength(2);
      viewer.rerender();
      expect(sourceLines(root)).toEqual(["\tconst a = 1; ", " \tconst a = 2;"]);
      expect(fileDiff.deletionLines.join("")).toBe(oldFile.contents);
      expect(fileDiff.additionLines.join("")).toBe(newFile.contents);
    } finally {
      viewer.cleanUp();
    }
  });

  it.each(["app.ts", "notes.txt"])(
    "keeps edits and undo in %s with markers enabled",
    async (name) => {
      using host = await setup();
      const { element, root, options } = host;
      const file = { name, contents: "\tconst a = 1;\n" };
      const viewer = new File(options);
      const editor = new Editor("file");
      try {
        viewer.render({ file, fileContainer: element });
        editor.edit(viewer);
        expect(editor.getText()).toBe(file.contents);
        editor.applyEdits([
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: " \t",
          },
        ]);
        await Promise.resolve();
        expect(editor.getText()).toBe(" \t\tconst a = 1;\n");
        expect(sourceLines(root)).toEqual([" \t\tconst a = 1;", ""]);
        expect(root.querySelectorAll('[data-code-whitespace="tab"]')).toHaveLength(2);
        editor.undo();
        expect(editor.getText()).toBe(file.contents);
      } finally {
        editor.cleanUp("discard");
        viewer.cleanUp();
      }
    },
  );

  it("retains unsaved text, selection and undo when tab size remounts the editor", async () => {
    using host = await setup();
    const { element, options } = host;
    const file = { name: "app.ts", contents: "\tconst a = 1;\n" };
    const first = new File(options);
    const editor = new Editor("file", {}, "tab-size-test");
    first.render({ file, fileContainer: element });
    editor.edit(first);
    editor.applyEdits([
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: " " },
    ]);
    editor.setSelections([
      { start: { line: 0, character: 2 }, end: { line: 0, character: 7 }, direction: "forward" },
    ]);
    const view = editor.getViewState();
    first.cleanUp();

    using replacement = await setup();
    replacement.element.style.setProperty("--diffs-tab-size", "8");
    const second = new File(replacement.options);
    const restored = new Editor("file", {}, "tab-size-test");
    try {
      // React attaches the keyed editor before hydrating its replacement File.
      restored.edit(second);
      second.render({ file, fileContainer: replacement.element });
      expect(restored.getText()).toBe("\t const a = 1;\n");
      expect(restored.getViewState().selections).toEqual(view.selections);
      expect(restored.canUndo).toBe(true);
      restored.undo();
      expect(restored.getText()).toBe(file.contents);
    } finally {
      second.cleanUp();
      EditStateManager.clear("file", "tab-size-test");
    }
  });

  it("starts a fresh draft when an external update replaces a retained source", async () => {
    using host = await setup();
    const { element, options } = host;
    const oldFile = { name: "app.ts", contents: "const oldValue = 1;\n" };
    const newFile = { name: "app.ts", contents: "const agentValue = 2;\n" };
    const first = new File(options);
    const editor = new Editor("file", {}, "external-source:0");
    first.render({ file: oldFile, fileContainer: element });
    editor.edit(first);
    editor.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: " " },
    ]);
    first.cleanUp();

    using replacement = await setup();
    const second = new File(replacement.options);
    const freshEditor = new Editor("file", {}, "external-source:1");
    try {
      // Worker highlighting renders the replacement read-only before attaching.
      second.render({ file: newFile, fileContainer: replacement.element });
      freshEditor.edit(second);
      expect(freshEditor.getText()).toBe(newFile.contents);
      expect(freshEditor.canUndo).toBe(false);
      freshEditor.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: " ",
        },
      ]);
      expect(freshEditor.getText()).toBe(` ${newFile.contents}`);
    } finally {
      second.cleanUp();
      EditStateManager.clear("file", "external-source:0");
      EditStateManager.clear("file", "external-source:1");
    }
  });

  it.each([2, 8])("uses native editing commands at %s-column tab stops", async (width) => {
    using host = await setup();
    const { element, root, options } = host;
    const viewer = new File(options);
    const editor = new Editor("file");
    const computedStyle = window.getComputedStyle.bind(window);
    using _styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((node) => {
      const style = computedStyle(node);
      // jsdom cannot resolve the shadow stylesheet's --diffs-tab-size variable.
      if (node.matches("[data-content]")) style.tabSize = String(width);
      return style;
    });
    try {
      viewer.render({
        file: { name: "notes.txt", contents: "        value\n" },
        fileContainer: element,
      });
      editor.edit(viewer);
      editor.setSelections([
        { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
      ]);
      const key = (key: string, modifiers: KeyboardEventInit = {}) => {
        root
          .querySelector("[data-content]")!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
          );
      };
      key("Tab");
      expect(editor.getText()).toBe(`${" ".repeat(8 + width)}value\n`);
      key("Tab", { shiftKey: true });
      expect(editor.getText()).toBe("        value\n");
      key("]", { ctrlKey: true });
      expect(editor.getText()).toBe(`${" ".repeat(8 + width)}value\n`);
      key("[", { ctrlKey: true });
      expect(editor.getText()).toBe("        value\n");
      root.querySelector("[data-content]")!.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(editor.getText()).toBe(`${" ".repeat(8 - width)}value\n`);
    } finally {
      editor.cleanUp("discard");
      viewer.cleanUp();
    }
  });

  it("commits an IME composition before applying an asynchronously resolved tab width", async () => {
    using display = await setup();
    const { options } = display;
    const file = { name: "notes.txt", contents: "before " };
    let currentEditor: Editor<"file"> | undefined;
    let attached = deferred();
    const createEditor: EditorFactory<undefined, undefined> = (type, editorOptions, key) =>
      new Editor(type, editorOptions, key);
    const editorOptions = {
      onAttach: (editor: Editor<"file">) => {
        currentEditor = editor;
        attached.resolve();
      },
    };
    const displayOptionsByTabSize = new Map(
      [2, 8].map((tabSize) => [
        tabSize,
        {
          ...options,
          onPostRender: (container: HTMLElement, instance: unknown, phase: PostRenderPhase) => {
            container.style.setProperty("--diffs-tab-size", String(tabSize));
            options.onPostRender(container, instance, phase);
          },
        },
      ]),
    );
    function Surface({ resolvedTabSize }: { resolvedTabSize: number }) {
      const { tabSize, ...compositionHandlers } = useEditorTabSize(resolvedTabSize, 0);
      const displayOptions = displayOptionsByTabSize.get(tabSize)!;
      return createElement(
        EditProvider<undefined, undefined>,
        { createEditor },
        createElement(
          "div",
          compositionHandlers,
          createElement(ReactFile<undefined, undefined>, {
            key: tabSize,
            editStateKey: "composing-width",
            style: { "--diffs-tab-size": tabSize } as CSSProperties,
            file,
            edit: true,
            editorOptions,
            options: displayOptions,
          }),
        ),
      );
    }
    using _retainedEdit = {
      [Symbol.dispose]: () => EditStateManager.clear("file", "composing-width"),
    };
    await using screen = await render(createElement(Surface, { resolvedTabSize: 2 }));
    {
      await act(async () => {
        await attached.promise;
      });
      const container = screen.container.querySelector<HTMLElement>("diffs-container")!;
      const content = container.shadowRoot!.querySelector("[data-content]")!;
      currentEditor!.setSelections([
        { start: { line: 0, character: 7 }, end: { line: 0, character: 7 }, direction: "none" },
      ]);
      await act(() => {
        content.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
        );
      });
      const text = content.querySelector('[data-code-whitespace="space"]')!.firstChild as Text;
      text.data = " 日本";
      await screen.rerender(createElement(Surface, { resolvedTabSize: 8 }));
      expect(screen.container.querySelector("diffs-container")).toBe(container);
      expect(content.contains(text)).toBe(true);
      expect(container.style.getPropertyValue("--diffs-tab-size")).toBe("2");
      attached = deferred();
      await act(() => {
        content.dispatchEvent(
          new CompositionEvent("compositionend", {
            bubbles: true,
            composed: true,
            data: "日本",
          }),
        );
      });
      await act(async () => {
        await attached.promise;
      });
      expect(currentEditor!.getText()).toBe("before 日本");
      const replacement = screen.container.querySelector<HTMLElement>("diffs-container")!;
      expect(replacement).not.toBe(container);
      expect(replacement.style.getPropertyValue("--diffs-tab-size")).toBe("8");
    }
  });
});
