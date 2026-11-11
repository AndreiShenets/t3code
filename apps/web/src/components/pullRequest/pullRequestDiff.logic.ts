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

/** The reader's own fold choice per file. It is absolute, so a Viewed mark loading later keeps it. */
export type FileDiffFoldChoices = ReadonlyMap<string, boolean>;

/**
 * A reader's own choice wins. Otherwise the toolbar decides, and a file still marked Viewed
 * starts folded. Fold all and Expand all clear the choices, so later pages follow the toolbar.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  choices: FileDiffFoldChoices,
  viewed = false,
): boolean {
  return choices.get(fileKey) ?? (foldOverride === "folded" || viewed);
}

export function withFileDiffFold(
  choices: FileDiffFoldChoices,
  fileKey: string,
  collapsed: boolean,
): FileDiffFoldChoices {
  if (choices.get(fileKey) === collapsed) return choices;
  return new Map(choices).set(fileKey, collapsed);
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
