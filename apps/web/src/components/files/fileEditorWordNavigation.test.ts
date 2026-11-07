import { TextDocument, type EditorSelection } from "@pierre/diffs/edit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const platformUrl = new URL("./editor/platform.js", import.meta.resolve("@pierre/diffs"));
const selectionUrl = new URL("./editor/selection.js", import.meta.resolve("@pierre/diffs"));
type CursorMove = "wordLeft" | "wordRight";
type NavigationEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;
const { isMoveCursorShortcut, resetPlatformDetection } = (await import(
  /* @vite-ignore */ platformUrl.href
)) as {
  isMoveCursorShortcut(event: NavigationEvent): CursorMove | undefined;
  resetPlatformDetection(): void;
};
const { mapCursorMove, mapSelectionShift } = (await import(
  /* @vite-ignore */ selectionUrl.href
)) as {
  mapCursorMove(
    document: TextDocument<"file", undefined>,
    selections: EditorSelection[],
    shortcut: CursorMove,
  ): EditorSelection[];
  mapSelectionShift(
    document: TextDocument<"file", undefined>,
    selections: EditorSelection[],
    shortcut: CursorMove,
  ): EditorSelection[];
};

function caret(character: number): EditorSelection {
  const position = { line: 0, character };
  return { start: position, end: position, direction: 0 };
}

function move(
  document: TextDocument<"file", undefined>,
  selections: EditorSelection[],
  key: string,
  modifiers: Partial<NavigationEvent> = { ctrlKey: true },
) {
  const event = {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
  const shortcut = isMoveCursorShortcut(event);
  expect(shortcut).toBeDefined();
  return (event.shiftKey ? mapSelectionShift : mapCursorMove)(document, selections, shortcut!);
}

beforeEach(() => {
  vi.stubGlobal("navigator", { platform: "Win32" });
  resetPlatformDetection();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPlatformDetection();
});

describe("file editor word navigation", () => {
  it("keeps Option+Arrow word movement and selection macOS-only", () => {
    expect(
      isMoveCursorShortcut({
        key: "ArrowRight",
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeUndefined();

    vi.stubGlobal("navigator", { platform: "MacIntel" });
    resetPlatformDetection();
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta");
    expect(move(document, [caret(2)], "ArrowRight", { altKey: true })).toEqual([caret(5)]);
    expect(move(document, [caret(2)], "ArrowLeft", { altKey: true })).toEqual([caret(0)]);
    expect(move(document, [caret(2)], "ArrowRight", { altKey: true, shiftKey: true })).toEqual([
      { start: caret(2).start, end: caret(5).end, direction: 1 },
    ]);
  });

  it("moves past an existing selection by word instead of only collapsing it", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta.gamma");
    const selection: EditorSelection = { start: caret(2).start, end: caret(8).end, direction: 1 };
    expect(move(document, [selection], "ArrowRight")).toEqual([caret(10)]);
    expect(move(document, [selection], "ArrowLeft")).toEqual([caret(0)]);
  });
});
