import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  PullRequestDiffResult,
  PullRequestDiffSide,
  PullRequestOmittedFileStat,
} from "@t3tools/contracts";

/** Only rendered hunks can anchor comments; list others off-diff. */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

export type DiffFoldOverride = "expanded" | "folded" | null;

/** Keep fold choices relative to the toolbar so later pages inherit Fold all. */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

export function toggleFileDiffFoldForViewed(
  fileKey: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (isFileDiffCollapsed(fileKey, foldOverride, toggledFileKeys) === viewed)
    return toggledFileKeys;
  const next = new Set(toggledFileKeys);
  if (next.has(fileKey)) next.delete(fileKey);
  else next.add(fileKey);
  return next;
}

export interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly headSha?: string | undefined;
  readonly baseSha?: string | undefined;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

// Cursors address one snapshot: only unchanged pages can vouch for the pages after them.
export function reconcileDiffSlices(slices: ReadonlyArray<DiffSlice>, answer: DiffSlice) {
  const index = slices.findIndex((slice) => slice.cursor === answer.cursor);
  if (index === -1) return { cursor: answer.cursor, slices: [...slices, answer] };
  const existing = slices[index];
  if (
    existing !== undefined &&
    existing.patch === answer.patch &&
    existing.headSha === answer.headSha &&
    existing.baseSha === answer.baseSha &&
    existing.truncated === answer.truncated &&
    existing.nextCursor === answer.nextCursor &&
    existing.omittedFileStats.length === answer.omittedFileStats.length &&
    existing.omittedFileStats.every((file, index) => {
      const refreshed = answer.omittedFileStats[index];
      return (
        refreshed !== undefined &&
        refreshed.path === file.path &&
        refreshed.additions === file.additions &&
        refreshed.deletions === file.deletions
      );
    })
  ) {
    return { cursor: slices[index + 1]?.cursor ?? answer.cursor, slices };
  }
  return { cursor: answer.cursor, slices: [...slices.slice(0, index), answer] };
}

export function getFileViewedRange<T extends { readonly fileKey: string }>(
  files: ReadonlyArray<T>,
  fileKey: string,
  anchorFileKey: string | null,
): ReadonlyArray<T> {
  const index = files.findIndex((file) => file.fileKey === fileKey);
  if (index === -1) return [];
  const anchorIndex = files.findIndex((file) => file.fileKey === anchorFileKey);
  if (anchorIndex === -1) return files.slice(index, index + 1);
  return files.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
}
