import type { CodeViewItem } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it, vi } from "vite-plus/test";

// Find-in-diff lives in our @pierre/diffs patch and is not a package export.
const searchUrl = new URL("./components/CodeViewSearch.js", import.meta.resolve("@pierre/diffs"));
const { collectMatches } = (await import(/* @vite-ignore */ searchUrl.href)) as {
  collectMatches(
    items: ReadonlyArray<CodeViewItem<undefined>>,
    params: { text: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean },
  ): Array<{
    id: string;
    headerField?: "name" | "prevName";
    side?: string;
    isContext?: boolean;
    lineNumber?: number;
    start: number;
    end: number;
    range: [number, number];
  }>;
};

type SearchMatch = ReturnType<typeof collectMatches>[number];
const { CodeView } = (await import(
  /* @vite-ignore */ new URL("./components/CodeView.js", import.meta.resolve("@pierre/diffs")).href
)) as {
  CodeView: {
    prototype: {
      revealSearchMatch(match: SearchMatch): void;
    };
  };
};

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const oldName = 2;
+const newName = 2;
+const added = oldName;
 const tail = 4;
@@ -20,3 +21,3 @@ function x() {
 ctx20 name
-del21 Name
+add22 names
 ctx22
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
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

function find(
  text: string,
  flags: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {},
) {
  return collectMatches(items, {
    text,
    caseSensitive: flags.caseSensitive ?? false,
    wholeWord: flags.wholeWord ?? false,
    regex: flags.regex ?? false,
  }).map(({ id, side, lineNumber, start, end }) => `${id}:${side}:${lineNumber}:${start}-${end}`);
}

describe("collectMatches", () => {
  it("searches file names and directory paths, including folded files", () => {
    const matches = collectMatches(items, {
      text: "src/",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(matches.map(({ id, headerField, start, end }) => [id, headerField, start, end])).toEqual(
      [
        ["file-0", "name", 0, 4],
        ["file-1", "name", 0, 4],
      ],
    );
  });

  it("keeps path and content matches in file order with distinct navigation offsets", () => {
    const matches = collectMatches(items, {
      text: "a",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(matches[0]).toMatchObject({ id: "file-0", headerField: "name", start: 4, end: 5 });
    expect(matches[1]).toMatchObject({ id: "file-0", side: "deletions", lineNumber: 2 });
    expect(matches.slice(1).every((match) => match.headerField === undefined)).toBe(true);
    expect(
      matches.slice(1).every((match, index) => match.range[0] > matches[index]!.range[1]),
    ).toBe(true);
  });

  it("honours search toggles in paths and treats literal dots literally", () => {
    expect(find("SRC/")).toHaveLength(2);
    expect(find("SRC/", { caseSensitive: true })).toEqual([]);
    expect(find("a.ts", { wholeWord: true })).toHaveLength(1);
    expect(find("a.t", { wholeWord: true })).toEqual([]);
    expect(find("src/[ab]\\.ts$", { regex: true })).toHaveLength(2);
    expect(find("aXts")).toEqual([]);
    expect(find("(?=src)", { regex: true })).toEqual([]);
  });

  it("searches both paths of a rename even without content hunks, without duplicating unchanged paths", () => {
    const renamed = {
      ...items[0]!,
      fileDiff: {
        ...items[0]!.fileDiff,
        name: "src/new.ts",
        prevName: "src/old.ts",
        hunks: [],
      },
    } satisfies CodeViewItem<undefined>;
    const params = { text: "src/", caseSensitive: false, wholeWord: false, regex: false };
    expect(collectMatches([renamed], params).map(({ headerField }) => headerField)).toEqual([
      "prevName",
      "name",
    ]);
    expect(
      collectMatches(
        [{ ...renamed, fileDiff: { ...renamed.fileDiff, prevName: renamed.fileDiff.name } }],
        params,
      ).map(({ headerField }) => headerField),
    ).toEqual(["name"]);
  });

  it("reveals a folded file's matching path without unfolding it or leaving a pending line reveal", () => {
    const match = collectMatches(items, {
      text: "b.ts",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    })[0]!;
    const view = {
      idToItem: new Map([[match.id, { type: "diff", item: items[1] }]]),
      cancelSearchReveal: vi.fn(),
      scrollTo: vi.fn(),
      options: { onRevealSearchMatch: vi.fn() },
    };
    CodeView.prototype.revealSearchMatch.call(view, match);
    expect(view.cancelSearchReveal).toHaveBeenCalledOnce();
    expect(view.scrollTo).toHaveBeenCalledWith({
      type: "item",
      id: "file-1",
      align: "start",
      offset: -48,
    });
    expect(view.options.onRevealSearchMatch).not.toHaveBeenCalled();
  });

  it("finds removed, added, and context lines in render order, folded files included", () => {
    expect(find("oldName")).toEqual(["file-0:deletions:2:6-13", "file-0:additions:3:14-21"]);
    expect(find("nil")).toEqual(["file-1:deletions:1:0-3", "file-1:additions:1:2-5"]);
  });
});
