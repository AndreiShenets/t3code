import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type PullRequestDiffResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { RightPanelSurfaceContent } from "../chat/RightPanelSurfaceContent";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { createPullRequestViewState, getPullRequestViewState } from "./pullRequestViewState";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

import "~/index.css";
import { act, render as renderUi } from "../../../test/render";

const codeTest = vi.hoisted(() => ({
  turnRefresh: 0,
  detail: null as PullRequestDetailView | null,
  pages: new Map<string, Atom.Writable<AsyncResult.AsyncResult<PullRequestDiffResult>>>(),
  emptyDiff: undefined as unknown,
  refresh: vi.fn(),
  hostCommand: vi.fn(),
  newThread: vi.fn(),
  prepareThread: vi.fn(),
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => undefined) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => codeTest.newThread) as never,
}));
vi.mock(import("~/state/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    run: codeTest.prepareThread,
    isAllowed: true,
    error: null,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => codeTest.hostCommand) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const cannotWriteGuides = Atom.make(false);
  codeTest.emptyDiff = Atom.make(null);
  return {
    ...actual,
    usePullRequestTurnRefresh: () => codeTest.turnRefresh,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: (() => "detail") as never,
      activity: (() => "activity") as never,
      reviewGuide: (() => "review-guide") as never,
      diff: (({ input }) =>
        codeTest.pages.get(input.cursor ?? "first") ??
        codeTest.emptyDiff) as typeof actual.pullRequestEnvironment.diff,
      generateReviewGuide: {
        ...actual.pullRequestEnvironment.generateReviewGuide,
        permissionAtom: () => cannotWriteGuides,
      },
    },
  };
});
vi.mock(import("~/state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: ((query: unknown) => {
      if (query === codeTest.emptyDiff || [...codeTest.pages.values()].includes(query as never)) {
        return actual.useEnvironmentQuery(query as never);
      }
      return {
        data: query === "detail" ? codeTest.detail : null,
        dataUpdatedAt: 0,
        failure: null,
        isPending: false,
        isSuccess: true,
        error: null,
        refresh: codeTest.refresh,
      };
    }) as never,
  };
});
vi.mock(import("~/state/usePullRequestStack"), () => ({
  usePullRequestStack: (() => ({
    data: null,
    isSuccess: true,
    isPending: false,
    error: null,
    refresh: codeTest.refresh,
  })) as never,
}));
vi.mock(import("./PullRequestSummaryTab"), () => ({
  PullRequestSummaryTab: ({
    scrollerRef,
  }: ComponentProps<typeof import("./PullRequestSummaryTab").PullRequestSummaryTab>) => (
    <div ref={scrollerRef} data-testid="summary-scroller" className="h-full overflow-y-auto">
      <div className="h-[3000px]" />
    </div>
  ),
}));

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};
const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const surface = { projectId: detail.projectId, repository: detail.repository, number: 1 };
const shortcutContext = () => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

function panel(props: Partial<ComponentProps<typeof PullRequestDetailPanel>> = {}) {
  return (
    <AppAtomRegistryProvider>
      <PullRequestDetailPanel
        environmentId={threadRef.environmentId}
        reference={detail}
        context="page"
        shortcutsEnabled={false}
        getShortcutContext={shortcutContext}
        {...props}
      />
    </AppAtomRegistryProvider>
  );
}

function panelContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  return container;
}

function render(props: Partial<ComponentProps<typeof PullRequestDetailPanel>> = {}) {
  return renderUi(panel(props), { container: panelContainer() });
}

function setup() {
  codeTest.turnRefresh = 0;
  codeTest.detail = detail;
  codeTest.pages.clear();
  codeTest.refresh.mockReset();
  codeTest.hostCommand.mockReset();
  codeTest.newThread.mockReset();
  codeTest.prepareThread.mockReset();
  useRightPanelStore.setState({ byThreadKey: {} });
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
}

const codePatch = (path: string, increment = 1) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,150 +1,150 @@
${Array.from({ length: 150 }, (_, index) => `-const old${index} = ${index};`).join("\n")}
${Array.from({ length: 150 }, (_, index) => `+const next${index} = ${index + increment};`).join("\n")}
`;

const commentPatch = (value = 1) => `diff --git a/review.ts b/review.ts
new file mode 100644
--- /dev/null
+++ b/review.ts
@@ -0,0 +1,2 @@
+const reviewMe = ${value};
+export { reviewMe };
`;

function setupInlineReview() {
  setup();
  codeTest.detail = {
    ...detail,
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, inlineComment: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
  const result = {
    patch: commentPatch(),
    truncated: false,
    nextCursor: null,
  } satisfies PullRequestDiffResult;
  const atom = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(result),
  );
  codeTest.pages.set("first", atom);
  return { atom, result };
}

async function beginInlineComment() {
  await page.getByRole("button", { name: "Expand diff", exact: true }).click();
  const line = page.getByText("const reviewMe = 1;", { exact: true });
  await expect.element(line).toBeVisible();
  const root = line.element().getRootNode() as ShadowRoot;
  const gutter = root.querySelector<HTMLElement>('[data-column-number="1"]')!;
  await userEvent.click(gutter);
  const input = page.getByRole("textbox", { name: "Comment on lines review.ts:1" });
  await expect.element(input).toBeVisible();
  return input;
}

it.each(["Cancel", "Add to review"])(
  "keeps an inline draft through an editor round trip and clears it after %s",
  async (action) => {
    setupInlineReview();
    useRightPanelStore.getState().openPullRequest(threadRef, { ...surface, detailTab: "code" });
    const selected = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    )!;
    const viewState = getPullRequestViewState(threadRef, selected);
    await using screen = await render({ viewState, initialTab: "code" });
    const input = await beginInlineComment();
    await input.fill("Check this condition");
    const selectedLines = viewState.getState().code?.selectedLines;
    expect(selectedLines?.range).toMatchObject({ start: 1, end: 1 });

    useRightPanelStore.getState().openFile(threadRef, "review.ts");
    await screen.rerender(<textarea aria-label="File editor" />);
    await expect.element(page.getByRole("textbox", { name: "File editor" })).toBeVisible();
    useRightPanelStore.getState().openPullRequest(threadRef, surface);
    const returned = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    )!;
    expect(getPullRequestViewState(threadRef, returned)).toBe(viewState);
    await screen.rerender(
      panel({
        viewState,
        initialTab:
          returned.kind === "pull-request" ? (returned.detailTab ?? "summary") : "summary",
      }),
    );

    const restored = page.getByRole("textbox", { name: "Comment on lines review.ts:1" });
    await expect.element(restored).toHaveValue("Check this condition");
    expect(viewState.getState().code?.selectedLines).toEqual(selectedLines);
    const root = page
      .getByText("const reviewMe = 1;", { exact: true })
      .element()
      .getRootNode() as ShadowRoot;
    await vi.waitFor(() =>
      expect(root.querySelector('[data-column-number="1"][data-selected-line]')).not.toBeNull(),
    );
    await restored.fill("Check this condition before merging");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.element(restored).not.toBeInTheDocument();
    if (action === "Add to review") {
      expect(usePullRequestReviewStore.getState().drafts[pullRequestReviewKey(detail)]).toEqual([
        expect.objectContaining({ path: "review.ts", body: "Check this condition before merging" }),
      ]);
    }
    await screen.rerender(null);
    await screen.rerender(panel({ viewState, initialTab: "code" }));
    await expect
      .element(page.getByRole("textbox", { name: "Comment on lines review.ts:1" }))
      .not.toBeInTheDocument();
    expect(viewState.getState().code?.draft).toBeNull();
    expect(viewState.getState().code?.draftText).toBe("");
  },
);

it("discards an inline draft when its file changes instead of attaching it to different code", async () => {
  const { atom, result } = setupInlineReview();
  const viewState = createPullRequestViewState();
  await using _screen = await render({ viewState, initialTab: "code" });
  const input = await beginInlineComment();
  await input.fill("Comment on the original code");
  await act(async () => {
    appAtomRegistry.set(atom, AsyncResult.success({ ...result, patch: commentPatch(2) }));
  });
  await expect.element(page.getByText("const reviewMe = 2;", { exact: true })).toBeVisible();
  await expect.element(input).not.toBeInTheDocument();
  expect(viewState.getState().code?.draft).toBeNull();
  expect(viewState.getState().code?.selectedLines).toBeNull();
  expect(usePullRequestReviewStore.getState().drafts).toEqual({});
});

it("keeps an inline draft when another file changes", async () => {
  const { atom, result } = setupInlineReview();
  const viewState = createPullRequestViewState();
  await using _screen = await render({ viewState, initialTab: "code" });
  const input = await beginInlineComment();
  await input.fill("Keep this finding");
  await act(async () => {
    appAtomRegistry.set(
      atom,
      AsyncResult.success({ ...result, patch: commentPatch() + codePatch("unrelated.ts") }),
    );
  });
  await expect.element(page.getByText("2 files", { exact: true })).toBeVisible();
  await expect.element(input).toHaveValue("Keep this finding");
});

it("does not restore an inline draft into another pull request", async () => {
  setupInlineReview();
  const viewState = createPullRequestViewState();
  await using screen = await render({ viewState, initialTab: "code" });
  const input = await beginInlineComment();
  await input.fill("Only for the first pull request");
  await screen.rerender(null);
  const other = { ...detail, number: 2 };
  codeTest.detail = other;
  await screen.rerender(panel({ viewState, initialTab: "code", reference: other }));
  await page.getByRole("button", { name: "Expand diff", exact: true }).click();
  await expect.element(page.getByText("const reviewMe = 1;", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Comment on lines review.ts:1" }))
    .not.toBeInTheDocument();
  expect(viewState.getState().code?.draft).toBeNull();
});

it.each([
  ["first.ts", "turn", "expanded"],
  ["second.ts", "turn", "expanded"],
  ["first.ts", "revision", "expanded"],
  ["second.ts", "revision", "expanded"],
  ["first.ts", "turn", "folded"],
  ["second.ts", "turn", "folded"],
  ["first.ts", "revision", "folded"],
  ["second.ts", "revision", "folded"],
] as const)(
  "keeps folds, focus and scroll when %s changes on a %s refresh (%s by default)",
  async (changedPath, trigger, foldOverride) => {
    setup();
    const result = {
      patch: codePatch("first.ts") + codePatch("second.ts"),
      truncated: false,
      nextCursor: null,
      omittedFileStats: [],
    } satisfies PullRequestDiffResult;
    const atom = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
      AsyncResult.success(result),
    );
    codeTest.pages.set("first", atom);
    const viewState = createPullRequestViewState();
    viewState.setState({
      condensedByTab: { code: true },
      code: {
        scopeKey: JSON.stringify([threadRef.environmentId, pullRequestReviewKey(detail), null]),
        slices: [{ ...result, source: result, cursor: null }],
        toggledFiles: new Set(),
        foldOverride,
        visibleCommitCount: 10,
        wordWrap: false,
        ignoreWhitespace: false,
      },
    });
    await using screen = await render({ viewState, initialTab: "code" });
    const toggle =
      foldOverride === "folded"
        ? page.getByRole("button", { name: "Expand diff", exact: true }).nth(1)
        : page.getByRole("button", { name: "Collapse diff", exact: true }).first();
    await expect.element(toggle).toBeVisible();
    await toggle.click();
    const collapse = page.getByRole("button", { name: "Collapse diff", exact: true });
    await expect.element(collapse).toBeVisible();
    const focused = collapse.element() as HTMLButtonElement;
    const viewer = document.querySelector<HTMLElement>(".diff-render-surface")!;
    await act(async () => {
      await document.fonts.ready;
      const scrolled = new Promise<void>((resolve) =>
        viewer.addEventListener("scroll", () => resolve(), { once: true }),
      );
      viewer.scrollTop = 400;
      focused.focus({ preventScroll: true });
      await scrolled;
    });
    const top = viewer.scrollTop;
    expect(top).toBeGreaterThan(0);

    await act(async () => {
      appAtomRegistry.set(atom, AsyncResult.waiting(AsyncResult.success(result)));
      if (trigger === "turn") codeTest.turnRefresh++;
      else codeTest.detail = { ...detail, updatedAt: "2026-09-02T00:00:00Z" };
    });
    await screen.rerender(panel({ viewState, initialTab: "code" }));
    expect(document.querySelector(".diff-render-surface")).toBe(viewer);
    expect(viewer.scrollTop).toBe(top);
    const refreshed = {
      ...result,
      patch:
        codePatch("first.ts", changedPath === "first.ts" ? 2 : 1) +
        codePatch("second.ts", changedPath === "second.ts" ? 2 : 1),
    };
    await act(async () => {
      appAtomRegistry.set(atom, AsyncResult.success(refreshed));
    });
    await vi.waitFor(() =>
      expect(viewState.getState().code?.slices[0]?.patch).toBe(refreshed.patch),
    );
    await expect.element(collapse).toBeVisible();
    expect(collapse.element()).toBe(focused);
    expect((focused.getRootNode() as ShadowRoot).activeElement).toBe(focused);
    expect(document.querySelector(".diff-render-surface")).toBe(viewer);
    expect(viewer.scrollTop).toBe(top);
    if (changedPath === "second.ts") {
      await act(async () => {
        viewer.scrollTop = viewer.scrollHeight;
      });
      await expect
        .element(page.getByText("const next149 = 151;", { exact: true }))
        .toBeInTheDocument();
    }
    await act(async () => {
      viewer.scrollTop = 0;
    });
    await expect
      .element(page.getByRole("button", { name: "Expand diff", exact: true }))
      .toBeVisible();
  },
);

it("keeps loaded pages during background reads and restores them after returning", async () => {
  setup();
  const first = {
    patch: codePatch("first.ts"),
    truncated: false,
    nextCursor: "second",
    omittedFileStats: [],
  } satisfies PullRequestDiffResult;
  const second = {
    patch: codePatch("second.ts"),
    truncated: false,
    nextCursor: null,
    omittedFileStats: [],
  } satisfies PullRequestDiffResult;
  const firstAtom = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(first),
  );
  const secondAtom = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(second),
  );
  codeTest.pages.set("first", firstAtom);
  codeTest.pages.set("second", secondAtom);
  const viewState = createPullRequestViewState();
  viewState.setState({
    condensedByTab: { code: true },
    scrollByTab: { code: { top: 9000, left: 0 } },
    code: {
      scopeKey: JSON.stringify([threadRef.environmentId, pullRequestReviewKey(detail), null]),
      slices: [
        { ...first, source: first, cursor: null },
        { ...second, source: second, cursor: "second" },
      ],
      toggledFiles: new Set(),
      foldOverride: "expanded",
      visibleCommitCount: 10,
      wordWrap: false,
      ignoreWhitespace: false,
    },
  });
  await using screen = await render({ viewState, initialTab: "code" });
  const viewer = () => document.querySelector<HTMLElement>(".diff-render-surface")!;
  await vi.waitFor(() => expect(viewer()?.scrollTop ?? 0).toBeGreaterThan(6000));
  const node = viewer();
  await document.fonts.ready;
  await expect.element(page.getByText("second.ts", { exact: true })).toBeVisible();
  const top = node.scrollTop;
  await act(async () => {
    appAtomRegistry.set(firstAtom, AsyncResult.waiting(AsyncResult.success(first)));
    codeTest.turnRefresh++;
  });
  await screen.rerender(panel({ viewState, initialTab: "code" }));
  expect(viewer()).toBe(node);
  expect(node.scrollTop).toBe(top);
  await act(async () => {
    appAtomRegistry.set(firstAtom, AsyncResult.success(first));
    appAtomRegistry.set(secondAtom, AsyncResult.success(second));
    codeTest.detail = { ...detail, updatedAt: "2026-09-02T00:00:00Z" };
  });
  await screen.rerender(panel({ viewState, initialTab: "code" }));
  expect(viewer()).toBe(node);
  expect(node.scrollTop).toBe(top);
  await expect.element(page.getByText("2 files", { exact: true })).toBeVisible();
  await screen.rerender(null);
  await screen.rerender(panel({ viewState, initialTab: "code" }));
  await vi.waitFor(() => expect(viewer()?.scrollTop).toBe(top));
  await expect.element(page.getByText("second.ts", { exact: true })).toBeVisible();
});

it("restores the summary's scroll and folded title together", async () => {
  setup();
  const viewState = createPullRequestViewState();
  await using screen = await render({ viewState });
  const summary = page.getByTestId("summary-scroller").element();
  await act(async () => {
    summary.scrollTop = 700;
    summary.dispatchEvent(new Event("scroll"));
  });
  const top = summary.scrollTop;
  await screen.rerender(null);
  await screen.rerender(panel({ viewState }));
  expect(page.getByTestId("summary-scroller").element().scrollTop).toBe(top);
  const title = page.getByRole("heading", { level: 1, name: "Test pull request" });
  expect(title.element().closest("[inert]")).not.toBeNull();
});

it("uses the owning surface's tab selection across thread and panel switches", async () => {
  setup();
  const otherThread = { ...threadRef, threadId: ThreadId.make("thread-2") };
  const result = {
    patch: codePatch("first.ts"),
    truncated: false,
    nextCursor: null,
  } satisfies PullRequestDiffResult;
  codeTest.pages.set(
    "first",
    Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(AsyncResult.success(result)),
  );
  useRightPanelStore.getState().openPullRequest(threadRef, surface);
  useRightPanelStore.getState().openPullRequest(otherThread, surface);
  const content = (ref: ScopedThreadRef) => {
    const selected = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
    return (
      <RightPanelSurfaceContent
        surface={selected}
        activeSurfaceId={selected?.id ?? null}
        threadRef={ref}
        environmentId={ref.environmentId}
        visible
        composerDraftTarget={ref}
        keybindings={[]}
        configuredPreviewUrls={[]}
        workspaceMutationId={null}
        sideChatParentPanel={{ openToolDiff: () => {}, runShellCommand: () => {} }}
        getShortcutContext={shortcutContext}
        onSendAnnotation={() => {}}
        onCloseSurface={() => {}}
        terminal={{
          launchContext: null,
          keybindings: [],
          onAddTerminalContext: () => {},
          onSplitTerminal: () => {},
          onSplitTerminalVertical: () => {},
          onNewTerminal: () => {},
          onActiveTerminalChange: () => {},
          onCloseTerminal: () => {},
        }}
        pullRequest={{
          capabilityKnown: true,
          supported: true,
          projectId: detail.projectId,
          pullRequests: [],
          linkedPullRequest: null,
          branchPullRequest: null,
          onBack: undefined,
        }}
        files={{
          projectName: null,
          workspaceRoot: undefined,
          availableEditors: [],
          pendingSurfaceIds: new Set(),
          onOpenFile: () => {},
          onPendingChange: () => {},
        }}
      />
    );
  };
  await using screen = await renderUi(content(threadRef), { container: panelContainer() });
  const show = (ref: ScopedThreadRef) => screen.rerender(content(ref));
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect.element(page.getByText("first.ts", { exact: true })).toBeVisible();
  await show(otherThread);
  await expect.element(page.getByTestId("summary-scroller")).toBeVisible();
  await show(threadRef);
  await expect.element(page.getByText("first.ts", { exact: true })).toBeVisible();
  await screen.rerender(null);
  await show(threadRef);
  await expect.element(page.getByText("first.ts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await show(otherThread);
  await show(threadRef);
  await expect.element(page.getByTestId("summary-scroller")).toBeVisible();
});
