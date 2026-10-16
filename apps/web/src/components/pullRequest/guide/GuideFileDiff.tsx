import {
  cloneFileDiffMetadata,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { useContext, useMemo } from "react";

import { useCodeDisplay } from "~/hooks/useCodeDisplay";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";
import { GuideProseContext } from "./GuideProse";

/**
 * A whole file's diff inside a stop, for a file the guide vouched for without excerpting. The row
 * above it names the file, so the renderer's own header is left off. The bars between hunks load
 * the unchanged lines, as in the Code tab.
 */
export function GuideFileDiff({
  file,
  loadDiffFiles,
}: {
  file: FileDiffMetadata;
  loadDiffFiles: FileDiffContentsLoader;
}) {
  const { resolvedTheme } = useTheme();
  const workspace = useContext(GuideProseContext);
  const filePath = resolveFileDiffPath(file);
  const { onPostRender: onCodePostRender } = useCodeDisplay(workspace, [filePath]);
  // Loading the unchanged lines rewrites the diff it is given; the excerpts read the same file
  // as a patch, so this view expands a copy of its own.
  const expandable = useMemo(() => cloneFileDiffMetadata(file), [file]);
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      disableFileHeader: true,
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
      onPostRender: (container, _instance, phase) => onCodePostRender(container, filePath, phase),
      loadDiffFiles,
    }),
    [filePath, loadDiffFiles, onCodePostRender, resolvedTheme],
  );
  return (
    <div className="border-t border-border/60">
      <FileDiff fileDiff={expandable} options={options} />
    </div>
  );
}
