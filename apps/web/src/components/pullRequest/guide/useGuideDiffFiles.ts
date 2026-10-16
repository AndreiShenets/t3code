import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

interface LoadedDiff {
  readonly key: string;
  /** The page asked for next; null is the first. */
  readonly cursor: string | null;
  /** No page left to ask for. */
  readonly done: boolean;
  readonly files: ReadonlyMap<string, FileDiffMetadata>;
}

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

/**
 * The pull request's parsed file diffs, read through the same paged query the Code tab uses, so
 * the pages are shared. Paging stops once every wanted path has arrived: a stop's excerpts are
 * usually in the first page, and a large change should not be read whole to show one of them.
 * Pages already read are kept, so going back to an earlier stop costs nothing.
 */
export function useGuideDiffFiles({
  environmentId,
  reference,
  headSha,
  wantedPaths,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** The current change's head, independent of when the guide was written. */
  headSha: string | null;
  wantedPaths: ReadonlyArray<string>;
}) {
  const key = `${environmentId}:${pullRequestReviewKey(reference)}:${headSha}`;
  const [loaded, setLoaded] = useState<LoadedDiff>({
    key,
    cursor: null,
    done: false,
    files: NO_FILES,
  });
  const current: LoadedDiff =
    loaded.key === key ? loaded : { key, cursor: null, done: false, files: NO_FILES };
  const refreshedPage = useRef<string | null>(null);
  const missing = wantedPaths.some((path) => !current.files.has(path));
  const loading = missing && !current.done;
  const query = useEnvironmentQuery(
    loading
      ? pullRequestEnvironment.diff({
          environmentId,
          input: { ...reference, ...(current.cursor === null ? {} : { cursor: current.cursor }) },
        })
      : null,
  );

  const data = query.data;
  const cursor = current.cursor;
  const pageKey = JSON.stringify([key, cursor]);
  const { refresh, isPending, isSuccess } = query;
  useEffect(() => {
    if (!loading) {
      refreshedPage.current = null;
      return;
    }
    // Whole-PR requests are unpinned. Refresh each page after a head change, even if
    // its cursor is reused, and never absorb the previous value retained by SWR.
    if (refreshedPage.current !== pageKey) {
      refreshedPage.current = pageKey;
      // An uncached page is already being fetched on mount. Cached pages have no
      // revision stamp, so revalidate those even when opening a guide afresh.
      if (data !== null || !isPending) refresh();
      return;
    }
    if (data === null || isPending || !isSuccess) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Retain asynchronous query pages after advancing or unsubscribing.
    setLoaded((previous) => {
      const base =
        previous.key === key ? previous : { key, cursor: null, done: false, files: NO_FILES };
      // A page is absorbed once; the query hands the same answer back on every render.
      if (base.cursor !== cursor || base.done) return base;
      const parsed = getRenderablePatch(
        data.patch,
        `pull-request-guide:${key}:${cursor ?? "first"}`,
      );
      const files = new Map(base.files);
      if (parsed?.kind === "files") {
        for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
      }
      return { key, cursor: data.nextCursor, done: data.nextCursor === null, files };
    });
  }, [cursor, data, isPending, isSuccess, key, loading, pageKey, refresh]);

  return {
    files: current.files,
    loading: loading && query.error === null,
    error: loading ? query.error : null,
    retry: query.refresh,
  };
}
