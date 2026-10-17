import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

interface LoadedDiff {
  readonly key: string;
  readonly cursor: string | null;
  readonly done: boolean;
  readonly files: ReadonlyMap<string, FileDiffMetadata>;
}

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

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
