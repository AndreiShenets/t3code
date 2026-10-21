import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SelectedLineRange } from "@pierre/diffs";
import type { PullRequestReviewPosition, ScopedThreadRef } from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

import { useRightPanelStore, type PullRequestDetailTab } from "~/rightPanelStore";
import type { DiffFoldOverride, DiffSlice } from "./pullRequestDiff.logic";

export interface PullRequestDraftAnchor {
  readonly headSha?: string | undefined;
  readonly baseSha?: string | undefined;
  readonly fileKey: string;
  readonly fileVersion: number;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}

export interface PullRequestViewState {
  timelineOrder?: "newest" | "oldest";
  commitOid?: string | null;
  condensedByTab?: Partial<Record<PullRequestDetailTab, boolean>>;
  scrollByTab: Partial<Record<PullRequestDetailTab, { top: number; left: number }>>;
  code?: {
    scopeKey: string;
    slices: ReadonlyArray<DiffSlice>;
    toggledFiles: ReadonlySet<string>;
    foldOverride: DiffFoldOverride;
    visibleCommitCount: number;
    wordWrap: boolean;
    ignoreWhitespace: boolean;
    draft?: PullRequestDraftAnchor | null;
    draftText?: string;
    selectedLines?: { id: string; range: SelectedLineRange } | null;
  };
}

let nextViewId = 0;

export function createPullRequestViewState() {
  return Object.assign(
    createStore<PullRequestViewState>()(() => ({ scrollByTab: {} })),
    {
      instanceId: ++nextViewId,
    },
  );
}

export type PullRequestViewStateStore = ReturnType<typeof createPullRequestViewState>;

export function savePullRequestScroll(
  viewState: PullRequestViewStateStore | undefined,
  tab: PullRequestDetailTab,
  scroller: HTMLElement,
) {
  viewState?.setState((state) => ({
    scrollByTab: {
      ...state.scrollByTab,
      [tab]: { top: scroller.scrollTop, left: scroller.scrollLeft },
    },
  }));
}

// Keep patches out of persisted UI storage and unmount hidden viewers instead of leaving
// every open review subscribed to environment updates. Closing any owning tab releases it.
const views = new Map<string, Map<string, PullRequestViewStateStore>>();

export function getPullRequestViewState(
  ref: ScopedThreadRef,
  surface: { readonly id: string },
): PullRequestViewStateStore {
  const key = scopedThreadKey(ref);
  const surfaceId = surface.id;
  // Exit animations can still render a surface after its close action has removed it.
  if (
    !useRightPanelStore
      .getState()
      .byThreadKey[key]?.surfaces.some(
        (surface) => surface.id === surfaceId && surface.kind === "pull-request",
      )
  ) {
    return createPullRequestViewState();
  }
  let threadViews = views.get(key);
  if (threadViews === undefined) {
    threadViews = new Map();
    views.set(key, threadViews);
  }
  let view = threadViews.get(surfaceId);
  if (view === undefined) {
    view = createPullRequestViewState();
    threadViews.set(surfaceId, view);
  }
  return view;
}

useRightPanelStore.subscribe((state, previous) => {
  if (state.byThreadKey === previous.byThreadKey) return;
  for (const [key, threadViews] of views) {
    const surfaces = state.byThreadKey[key]?.surfaces;
    if (surfaces === previous.byThreadKey[key]?.surfaces) continue;
    for (const id of threadViews.keys()) {
      if (!surfaces?.some((surface) => surface.id === id && surface.kind === "pull-request")) {
        threadViews.delete(id);
      }
    }
    if (threadViews.size === 0) views.delete(key);
  }
});
