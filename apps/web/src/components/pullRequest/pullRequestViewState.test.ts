import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { pullRequestSurfaceId, useRightPanelStore } from "~/rightPanelStore";
import { getPullRequestViewState as getView } from "./pullRequestViewState";

const getPullRequestViewState = (ref: ScopedThreadRef, id: string) => getView(ref, { id });

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread-a"),
};
const target = { projectId: "project", repository: "owner/repo", number: 7 };
const id = pullRequestSurfaceId(target);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().openPullRequest(ref, target);
});

describe("pull request view lifetime", () => {
  it("keeps the view when another panel or thread is active or the sidebar is hidden", () => {
    const view = getPullRequestViewState(ref, id);
    view.setState({
      tab: "code",
      commitOid: "commit-a",
      scrollByTab: { code: { top: 2500, left: 30 } },
    });
    const store = useRightPanelStore.getState();
    store.open(ref, "files");
    store.close(ref);
    store.openPullRequest({ ...ref, threadId: ThreadId.make("thread-b") }, target);
    store.openPullRequest(ref, { ...target, url: "https://github.com/owner/repo/pull/7" });

    expect(getPullRequestViewState(ref, id)).toBe(view);
    expect(view.getState().scrollByTab.code).toEqual({ top: 2500, left: 30 });
  });

  it("isolates matching PRs by thread, environment, host and surface", () => {
    const view = getPullRequestViewState(ref, id);
    view.setState({ tab: "code" });
    for (const [otherRef, otherTarget] of [
      [{ ...ref, threadId: ThreadId.make("thread-b") }, target],
      [{ ...ref, environmentId: EnvironmentId.make("env-b") }, target],
      [ref, { ...target, host: "enterprise.example" }],
      [ref, { ...target, number: 8 }],
    ] as const) {
      useRightPanelStore.getState().openPullRequest(otherRef, otherTarget);
      const otherId = pullRequestSurfaceId(otherTarget);
      const otherView = getPullRequestViewState(otherRef, otherId);
      expect(otherView.getState().tab).toBeUndefined();
      otherView.setState({ tab: "timeline" });
      expect(getPullRequestViewState(otherRef, otherId)).toBe(otherView);
      expect(getPullRequestViewState(ref, id).getState().tab).toBe("code");
    }
  });

  it.each(["one", "others", "right", "all", "thread"] as const)(
    "releases the view when closing %s, even if an unmount later writes its old snapshot",
    (mode) => {
      const store = useRightPanelStore.getState();
      store.open(ref, "files");
      store.moveSurface(ref, "files", 0);
      const oldView = getPullRequestViewState(ref, id);
      if (mode === "one") store.closeSurface(ref, id);
      if (mode === "others") store.closeOtherSurfaces(ref, "files");
      if (mode === "right") store.closeSurfacesToRight(ref, "files");
      if (mode === "all") store.closeAllSurfaces(ref);
      if (mode === "thread") store.removeThread(ref);
      // A closing panel can finish its exit animation after the store removed its tab.
      const exiting = getPullRequestViewState(ref, id);
      exiting.setState({ tab: "timeline" });
      oldView.setState({ tab: "code", scrollByTab: { code: { top: 3000, left: 0 } } });
      store.openPullRequest(ref, target);

      const reopened = getPullRequestViewState(ref, id);
      expect(reopened).not.toBe(oldView);
      expect(reopened.instanceId).not.toBe(oldView.instanceId);
      expect(reopened.getState().tab).toBeUndefined();
      expect(reopened.getState().scrollByTab).toEqual({});
    },
  );
});
