import type { CodeViewItem } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

interface SearchMatch {
  itemId: string;
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
    };
  };
};

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
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

describe("diff content search", () => {
  it("keeps filename and directory matches out of content find", () => {
    expect(collectMatches(items, "src/")).toEqual([]);
    expect(collectMatches(items, "b.ts")).toEqual([]);
  });

  it("keeps deletion, addition, and folded-file content matches", () => {
    expect(collectMatches(items, "oldName")).toMatchObject([
      { itemId: "file-0", side: "deletions", lineNumber: 2 },
      { itemId: "file-0", side: "additions", lineNumber: 3 },
    ]);
    expect(collectMatches(items, "nil")).toMatchObject([
      { itemId: "file-1", side: "deletions" },
      { itemId: "file-1", side: "additions" },
    ]);
  });

  it("honours the content find toggles", () => {
    expect(collectMatches(items, "OLDNAME")).toHaveLength(2);
    expect(collectMatches(items, "OLDNAME", { caseSensitive: true })).toEqual([]);
    expect(collectMatches(items, "oldName", { wholeWord: true })).toHaveLength(2);
    expect(collectMatches(items, "old", { wholeWord: true })).toEqual([]);
    expect(collectMatches(items, "(old|new)Name", { regex: true })).toHaveLength(3);
  });

  it("does not find rename headers without content hunks", () => {
    const renamed = {
      ...items[0]!,
      fileDiff: { ...items[0]!.fileDiff, name: "src/new.ts", prevName: "src/old.ts", hunks: [] },
    };
    expect(collectMatches([renamed], "src/")).toEqual([]);
  });
});
