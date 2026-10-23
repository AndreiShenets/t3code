import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  reconcileDiffSlices,
  type DiffSlice,
  toggleFileDiffFoldForViewed,
} from "./pullRequestDiff.logic";

function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
): FileDiffMetadata {
  return { name: "src/app.ts", hunks } as unknown as FileDiffMetadata;
}

describe("isLineInFileDiff", () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it("includes the first line of a hunk and excludes the one past its last", () => {
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });
});

describe("reconcileDiffSlices", () => {
  const slice = (cursor: string | null, patch: string, nextCursor: string | null): DiffSlice => ({
    cursor,
    patch,
    truncated: false,
    nextCursor,
    omittedFileStats: [],
  });
  const loaded = [slice(null, "a", "2"), slice("2", "b", "3"), slice("3", "c", null)];

  it("appends a new page", () => {
    expect(reconcileDiffSlices(loaded.slice(0, 1), loaded[1]!)).toEqual({
      cursor: "2",
      slices: loaded.slice(0, 2),
    });
  });

  it("keeps all pages and their parsed identities while revalidating unchanged answers", () => {
    const first = reconcileDiffSlices(loaded, slice(null, "a", "2"));
    expect(first.cursor).toBe("2");
    expect(first.slices).toBe(loaded);
    expect(reconcileDiffSlices(first.slices, slice("2", "b", "3")).cursor).toBe("3");
    expect(reconcileDiffSlices(loaded, slice("3", "c", null))).toEqual({
      cursor: "3",
      slices: loaded,
    });
  });

  it("discards only pages after a changed page", () => {
    const changed = slice("2", "new b", "3");
    expect(reconcileDiffSlices(loaded, changed)).toEqual({
      cursor: "2",
      slices: [loaded[0], changed],
    });
  });

  it("does not keep later pages when snapshot, pagination or omitted file metadata changes", () => {
    for (const changed of [
      { ...loaded[0]!, headSha: "new-head" },
      { ...loaded[0]!, baseSha: "new-base" },
      { ...loaded[0]!, nextCursor: "new-cursor" },
      { ...loaded[0]!, truncated: true },
      { ...loaded[0]!, omittedFileStats: [{ path: "large.ts", additions: 20, deletions: 0 }] },
    ]) {
      expect(reconcileDiffSlices(loaded, changed).slices).toEqual([changed]);
    }
  });
});

describe("isFileDiffCollapsed", () => {
  // regression: #9174 diffs now expand by default; a reader's fold must survive new slices
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(false);
  });
});

describe("toggleFileDiffFoldForViewed", () => {
  it("moves against whatever the toolbar last asked for", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, "expanded", new Set())]).toEqual(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", false, "expanded", new Set()).size).toBe(0);
  });
});
