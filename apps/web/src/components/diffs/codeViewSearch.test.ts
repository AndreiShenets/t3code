import type { CodeViewItem } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it, vi } from "vite-plus/test";

interface SearchMatch {
  itemId: string;
  headerField?: "name" | "prevName";
  side?: string;
  lineNumber: number;
  startCharacter: number;
  endCharacter: number;
}

const { CodeView } = (await import(
  /* @vite-ignore */ new URL("./components/CodeView.js", import.meta.resolve("@pierre/diffs")).href
)) as {
  CodeView: {
    prototype: {
      searchDiffItem(
        item: { item: CodeViewItem<undefined> },
        params: object,
        limit: number,
      ): SearchMatch[];
      scrollToSearchMatch(match: SearchMatch): void;
    };
  };
};

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const oldName = 2;
+const newName = 2;
+const added = oldName;
 const tail = 4;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-nil
+: nil
`;

const items = parsePatchFiles(PATCH)[0]!.files.map(
  (fileDiff, index) =>
    ({
      id: `file-${index}`,
      type: "diff",
      fileDiff,
      collapsed: index === 1,
    }) satisfies CodeViewItem<undefined>,
);

function collectMatches(
  selectedItems: typeof items,
  text: string,
  flags: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {},
) {
  const view = {
    itemEditors: new Map(),
    searchState: {},
    options: { diffStyle: "unified", expandUnchanged: true },
  };
  return selectedItems.flatMap((item) =>
    CodeView.prototype.searchDiffItem.call(
      view,
      { item },
      { text, caseSensitive: false, wholeWord: false, regex: false, ...flags },
      100_000,
    ),
  );
}

describe("diff path search", () => {
  it("searches file names and directory paths, including folded files", () => {
    expect(collectMatches(items, "src/")).toMatchObject([
      { itemId: "file-0", headerField: "name", startCharacter: 0, endCharacter: 4 },
      { itemId: "file-1", headerField: "name", startCharacter: 0, endCharacter: 4 },
    ]);
  });

  it("keeps path and content matches in file order", () => {
    const matches = collectMatches(items, "a");
    expect(matches[0]).toMatchObject({ itemId: "file-0", headerField: "name", startCharacter: 4 });
    expect(matches[1]).toMatchObject({ itemId: "file-0", side: "deletions", lineNumber: 2 });
    expect(matches.slice(1).every((match) => match.headerField === undefined)).toBe(true);
  });

  it("honours search toggles in paths and treats literal dots literally", () => {
    expect(collectMatches(items, "SRC/")).toHaveLength(2);
    expect(collectMatches(items, "SRC/", { caseSensitive: true })).toEqual([]);
    expect(collectMatches(items, "a.ts", { wholeWord: true })).toHaveLength(1);
    expect(collectMatches(items, "a.t", { wholeWord: true })).toEqual([]);
    expect(collectMatches(items, "src/[ab]\\.ts$", { regex: true })).toHaveLength(2);
    expect(collectMatches(items, "aXts")).toEqual([]);
  });

  it("searches both paths of a rename without content hunks, without duplicating unchanged paths", () => {
    const renamed = {
      ...items[0]!,
      fileDiff: { ...items[0]!.fileDiff, name: "src/new.ts", prevName: "src/old.ts", hunks: [] },
    };
    expect(collectMatches([renamed], "src/").map((match) => match.headerField)).toEqual([
      "prevName",
      "name",
    ]);
    expect(
      collectMatches(
        [{ ...renamed, fileDiff: { ...renamed.fileDiff, prevName: renamed.fileDiff.name } }],
        "src/",
      ).map((match) => match.headerField),
    ).toEqual(["name"]);
  });

  it("reveals a folded path without unfolding it or leaving a pending line reveal", () => {
    const view = {
      searchState: { pendingReveal: "unfold" },
      render: vi.fn(),
      scrollTo: vi.fn(),
      options: { onRevealSearchMatch: vi.fn() },
    };
    CodeView.prototype.scrollToSearchMatch.call(view, collectMatches(items, "b.ts")[0]!);
    expect(view.searchState.pendingReveal).toBeUndefined();
    expect(view.scrollTo).toHaveBeenCalledWith({
      type: "item",
      id: "file-1",
      align: "start",
      offset: 48,
      behavior: "smooth-auto",
    });
    expect(view.options.onRevealSearchMatch).not.toHaveBeenCalled();
  });
});
