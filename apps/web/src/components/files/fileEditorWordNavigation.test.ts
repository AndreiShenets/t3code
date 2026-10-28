import { TextDocument, type EditorSelection } from "@pierre/diffs/edit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const platformUrl = new URL("./editor/platform.js", import.meta.resolve("@pierre/diffs"));
const selectionUrl = new URL("./editor/selection.js", import.meta.resolve("@pierre/diffs"));
type CursorMove = "left" | "right" | "start" | "textStart" | "end" | "wordLeft" | "wordRight";
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

function caret(character: number, line = 0): EditorSelection {
  const position = { line, character };
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
  it("moves Ctrl+Right to the next word boundary instead of the end of the line", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta.gamma");
    expect(move(document, [caret(0)], "ArrowRight")).toEqual([caret(5)]);
  });

  it.each(["Win32", "Linux x86_64", "MacIntel"])(
    "stops at words and punctuation on %s",
    (platform) => {
      vi.stubGlobal("navigator", { platform });
      resetPlatformDetection();
      const modifiers = platform === "MacIntel" ? { altKey: true } : { ctrlKey: true };
      const document = new TextDocument<"file", undefined>("code.ts", "alpha beta.gamma()");
      let selections = [caret(0)];
      for (const character of [5, 10, 11, 16, 18, 18]) {
        selections = move(document, selections, "ArrowRight", modifiers);
        expect(selections).toEqual([caret(character)]);
      }
      for (const character of [16, 11, 10, 6, 0, 0]) {
        selections = move(document, selections, "ArrowLeft", modifiers);
        expect(selections).toEqual([caret(character)]);
      }
    },
  );

  it("extends and reverses a word selection without losing its anchor", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta.gamma");
    const modifiers = { ctrlKey: true, shiftKey: true };
    let selections = move(document, [caret(6)], "ArrowRight", modifiers);
    expect(selections).toEqual([{ start: caret(6).start, end: caret(10).end, direction: 1 }]);
    selections = move(document, selections, "ArrowLeft", modifiers);
    expect(selections[0]?.start).toEqual(caret(6).start);
    expect(selections[0]?.end).toEqual(caret(6).end);
    selections = move(document, selections, "ArrowLeft", modifiers);
    expect(selections).toEqual([{ start: caret(0).start, end: caret(6).end, direction: -1 }]);
  });

  it("moves each caret independently", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta.gamma");
    expect(move(document, [caret(0), caret(11)], "ArrowRight")).toEqual([caret(5), caret(16)]);
  });

  it("stops at the current word edge when starting inside a word", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta");
    expect(move(document, [caret(2)], "ArrowRight")).toEqual([caret(5)]);
    expect(move(document, [caret(2)], "ArrowLeft")).toEqual([caret(0)]);
  });

  it("skips spaces and tabs before moving through the next word", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha \t  beta");
    expect(move(document, [caret(5)], "ArrowRight")).toEqual([caret(13)]);
    expect(move(document, [caret(9)], "ArrowLeft")).toEqual([caret(0)]);
  });

  it("keeps the caret at the bounds of an empty document", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "");
    expect(move(document, [caret(0)], "ArrowRight")).toEqual([caret(0)]);
    expect(move(document, [caret(0)], "ArrowLeft")).toEqual([caret(0)]);
  });

  it.each(["\n", "\r\n"])("crosses one %j line break at a time", (eol) => {
    const document = new TextDocument<"file", undefined>("code.ts", `alpha${eol}${eol}  beta`);
    let selections = [caret(5)];
    for (const position of [caret(0, 1), caret(0, 2), caret(6, 2)]) {
      selections = move(document, selections, "ArrowRight");
      expect(selections).toEqual([position]);
    }
    for (const position of [caret(2, 2), caret(0, 2), caret(0, 1), caret(5)]) {
      selections = move(document, selections, "ArrowLeft");
      expect(selections).toEqual([position]);
    }
  });

  it.each(["foo_bar42", "café", "e\u0301clair", "变量", "👩‍💻"])(
    "keeps %s intact rather than splitting its graphemes",
    (word) => {
      const document = new TextDocument<"file", undefined>("code.ts", `${word} next`);
      expect(move(document, [caret(0)], "ArrowRight")).toEqual([caret(word.length)]);
      expect(move(document, [caret(word.length)], "ArrowLeft")).toEqual([caret(0)]);
    },
  );

  it("leaves plain arrows and Home/End unchanged", () => {
    const document = new TextDocument<"file", undefined>("code.ts", "alpha beta.gamma");
    expect(move(document, [caret(6)], "ArrowRight", {})).toEqual([caret(7)]);
    expect(move(document, [caret(6)], "ArrowLeft", {})).toEqual([caret(5)]);
    expect(move(document, [caret(6)], "Home", {})).toEqual([caret(0)]);
    expect(move(document, [caret(6)], "End", {})).toEqual([caret(16)]);
  });

  it("preserves macOS Cmd+Arrow and Ctrl+B/F navigation", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    resetPlatformDetection();
    const document = new TextDocument<"file", undefined>("code.ts", "  alpha beta");
    expect(move(document, [caret(5)], "ArrowRight", { metaKey: true })).toEqual([caret(12)]);
    expect(move(document, [caret(5)], "ArrowLeft", { metaKey: true })).toEqual([caret(2)]);
    expect(move(document, [caret(5)], "b")).toEqual([caret(4)]);
    expect(move(document, [caret(5)], "f")).toEqual([caret(6)]);
  });

  it.each([{ ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true }, { altKey: true }])(
    "does not claim unrelated modifier combinations: %j",
    (modifiers) => {
      expect(
        isMoveCursorShortcut({
          key: "ArrowRight",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          ...modifiers,
        }),
      ).toBeUndefined();
    },
  );
});
