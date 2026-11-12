import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef, useState } from "react";

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
  const registry = useContext(RegistryContext);
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
  const { isPending, isSuccess } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates and retains asynchronous guide diff pages
  useEffect(() => {
    if (!loading) {
      refreshedPage.current = null;
      return;
    }
    let next = current;
    // Batch settled pages without render-phase updates, even for long cached chains.
    while (!next.done && wantedPaths.some((path) => !next.files.has(path))) {
      const atom = pullRequestEnvironment.diff({
        environmentId,
        input: { ...reference, ...(next.cursor === null ? {} : { cursor: next.cursor }) },
      });
      let result = registry.get(atom);
      const pageKey = JSON.stringify([key, next.cursor]);
      if (refreshedPage.current !== pageKey) {
        refreshedPage.current = pageKey;
        // Unpinned cached pages have no revision stamp, including reused later cursors.
        if (AsyncResult.getOrElse(result, () => null) !== null || !result.waiting) {
          registry.refresh(atom);
          result = registry.get(atom);
        }
      }
      if (next === current && (isPending || !isSuccess || data === null)) break;
      if (result.waiting || !AsyncResult.isSuccess(result)) break;
      const page = result.value;
      const parsed = getRenderablePatch(
        page.patch,
        `pull-request-guide:${key}:${next.cursor ?? "first"}`,
      );
      const files = new Map(next.files);
      if (parsed?.kind === "files") {
        for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
      }
      next = { key, cursor: page.nextCursor, done: page.nextCursor === null, files };
    }
    if (next !== current) {
      // oxlint-disable-next-line react/set-state-in-effect -- Retain asynchronous query pages after advancing or unsubscribing.
      setLoaded(next);
    }
  }, [
    current,
    data,
    environmentId,
    isPending,
    isSuccess,
    key,
    loading,
    reference,
    registry,
    wantedPaths,
  ]);

  return {
    files: current.files,
    loading: loading && query.error === null,
    error: loading ? query.error : null,
    retry: query.refresh,
  };
}
