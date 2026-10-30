import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestReviewGuide,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";

import type { GuideStop } from "./GuideStop";

type Target = { environmentId: EnvironmentId; input: PullRequestDiffInput };
type PendingRead = {
  target: Target;
  resolve: (page: PullRequestDiffResult) => void;
  reject: (error: Error) => void;
};
const state = vi.hoisted(() => ({
  pages: new Map<string | null, Atom.Writable<AsyncResult.AsyncResult<PullRequestDiffResult>>>(),
  reads: [] as PendingRead[],
  renderStop: vi.fn<(props: ComponentProps<typeof GuideStop>) => null>(),
  readContents: vi.fn(),
}));

vi.mock("~/state/pullRequests", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Data = await import("effect/Data");
  class DiffReadError extends Data.TaggedError("DiffReadError")<{ readonly message: string }> {}
  const pages = Atom.family((key: string) =>
    Atom.make(
      Effect.tryPromise({
        try: () =>
          new Promise<PullRequestDiffResult>((resolve, reject) => {
            state.reads.push({ target: JSON.parse(key), resolve, reject });
          }),
        catch: (error) =>
          new DiffReadError({ message: error instanceof Error ? error.message : String(error) }),
      }),
    ).pipe(Atom.swr({ staleTime: 60_000, revalidateOnMount: true }), Atom.setIdleTTL(5 * 60_000)),
  );
  return {
    pullRequestEnvironment: {
      diff: (target: Target) =>
        state.pages.get(target.input.cursor ?? null) ?? pages(JSON.stringify(target)),
      diffFileContents: {},
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.readContents }));
vi.mock("./GuideRail", () => ({ GuideRail: () => null }));
vi.mock("./GuideStop", () => ({ GuideStop: state.renderStop }));

import { pullRequestEnvironment } from "~/state/pullRequests";
import { GuideTour } from "./GuideTour";
import { guideProgressKey, guideRunKey, useGuideRunStore } from "./guideRunStore";

const environmentId = EnvironmentId.make("guide-environment");
const reference = {
  projectId: ProjectId.make("project"),
  host: "github.com",
  repository: "acme/repo",
  number: 7,
};
const guide: PullRequestReviewGuide = {
  headSha: "head-A",
  generatedAt: "2026-10-15T00:00:00Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  stops: ["First", "Second"].map((title, index) => ({
    title,
    summary: "Written at head A",
    attention: null,
    excerpts: [],
    files: (index === 0 ? ["a.ts"] : ["a.ts", "b.ts"]).map((path) => ({ path })),
    notes: [],
    questions: [],
  })),
};

import { useGuideDiffFiles } from "./useGuideDiffFiles";

function Probe({ wantedPaths }: { wantedPaths: string[] }) {
  const diff = useGuideDiffFiles({
    environmentId: EnvironmentId.make("test"),
    reference: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
    headSha: "new-head",
    wantedPaths,
  });
  return (
    <output>
      {JSON.stringify({
        loading: diff.loading,
        files: [...diff.files].map(([path, file]) => [path, file.additionLines.join("")]),
      })}
    </output>
  );
}

function page(
  path: string,
  value: string,
  nextCursor: string | null = null,
): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${value}\n`,
    truncated: false,
    nextCursor,
  };
}

function stop() {
  return state.renderStop.mock.lastCall![0];
}

function contents() {
  return [...stop().files].map(([path, file]) => [path, file.additionLines.join("").trim()]);
}

function tour(registry: AtomRegistry.AtomRegistry, headSha: string) {
  return (
    <RegistryContext.Provider value={registry}>
      <GuideTour
        environmentId={environmentId}
        reference={reference}
        guide={guide}
        headSha={headSha}
        banner={null}
        active={false}
        commenting={null}
        onAsk={null}
        onFinish={null}
        onOpenFile={() => {}}
      />
    </RegistryContext.Provider>
  );
}

async function loadA(registry: AtomRegistry.AtomRegistry) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(tour(registry, "head-A")));
  await act(() => state.reads[0]!.resolve(page("a.ts", "A first", "next")));
  await act(() => state.reads[1]!.resolve(page("b.ts", "A second")));
  expect(contents()).toEqual([
    ["a.ts", "A first"],
    ["b.ts", "A second"],
  ]);
  return Object.assign(stack.move(), { screen });
}

function setup() {
  const registry = AtomRegistry.make();
  state.pages.clear();
  state.reads = [];
  state.renderStop.mockReset().mockReturnValue(null);
  state.readContents
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }));
  useGuideRunStore.setState({ progress: {} });
  useGuideRunStore
    .getState()
    .setProgress(guideProgressKey(guideRunKey(environmentId, reference), guide.headSha), () => ({
      position: 1,
      seen: new Set([0]),
    }));
  return {
    registry,
    [Symbol.dispose]() {
      registry.dispose();
      useGuideRunStore.setState({ progress: {} });
    },
  };
}

describe("guide whole-PR diff revisions", () => {
  it("revalidates reused page cursors for head B while the guide and progress remain at A", async () => {
    using context = setup();
    await using loaded = await loadA(context.registry);
    const { screen } = loaded;
    const expandedA = await stop().loadDiffFiles(stop().files.get("a.ts")!);

    await screen.rerender(tour(context.registry, "head-B"));
    expect(state.reads).toHaveLength(3);
    expect(contents()).toEqual([]);
    expect(stop().diffLoading).toBe(true);
    expect(stop().index).toBe(1);
    expect(stop().stop.summary).toBe("Written at head A");

    await act(() => state.reads[2]!.resolve(page("a.ts", "B first", "next")));
    expect(state.reads).toHaveLength(4);
    expect(contents()).toEqual([["a.ts", "B first"]]);
    expect(stop().diffLoading).toBe(true);
    await act(() => state.reads[3]!.resolve(page("b.ts", "B second")));
    expect(contents()).toEqual([
      ["a.ts", "B first"],
      ["b.ts", "B second"],
    ]);
    expect(stop().diffLoading).toBe(false);
    expect(state.reads.map(({ target }) => target.input)).toEqual([
      reference,
      { ...reference, cursor: "next" },
      reference,
      { ...reference, cursor: "next" },
    ]);
    const expandedB = await stop().loadDiffFiles(stop().files.get("a.ts")!);
    expect(expandedB.newFile.cacheKey).not.toBe(expandedA.newFile.cacheKey);
    expect(state.readContents.mock.lastCall![0].input).not.toHaveProperty("commit");

    await act(() => stop().onStep(-1));
    await act(() => stop().onStep(1));
    expect(stop().index).toBe(1);
    expect(state.reads).toHaveLength(4);
  });

  it("revalidates shared pages when reopening the guide at a newer head", async () => {
    using context = setup();
    await using loaded = await loadA(context.registry);
    await loaded.screen.unmount();
    await using _screen = await render(tour(context.registry, "head-B"));
    expect(contents()).toEqual([]);
    expect(state.reads).toHaveLength(3);
    await act(() => state.reads[2]!.resolve(page("b.ts", "B reopened")));
    expect(contents()).toEqual([["b.ts", "B reopened"]]);
  });

  it("does not absorb retained head A data when the refresh for B fails", async () => {
    using context = setup();
    await using loaded = await loadA(context.registry);
    const { screen } = loaded;
    await screen.rerender(tour(context.registry, "head-B"));
    await act(() => state.reads[2]!.reject(new Error("offline")));
    expect(contents()).toEqual([]);
    expect(stop().diffLoading).toBe(false);
    expect(screen.container.textContent).toContain("offline");

    await act(() =>
      context.registry.refresh(pullRequestEnvironment.diff({ environmentId, input: reference })),
    );
    await act(() => state.reads[3]!.resolve(page("b.ts", "B only")));
    expect(contents()).toEqual([["b.ts", "B only"]]);
    expect(stop().diffLoading).toBe(false);
  });

  it("ignores a late response for B after the current head changes again", async () => {
    using context = setup();
    await using loaded = await loadA(context.registry);
    const { screen } = loaded;
    await screen.rerender(tour(context.registry, "head-B"));
    await screen.rerender(tour(context.registry, "head-C"));
    expect(state.reads).toHaveLength(4);
    await act(() => state.reads[2]!.resolve(page("a.ts", "obsolete B")));
    expect(contents()).toEqual([]);
    await act(() => state.reads[3]!.resolve(page("b.ts", "C only")));
    expect(contents()).toEqual([["b.ts", "C only"]]);
    expect(stop().diffLoading).toBe(false);
  });
  it.each([
    { name: "contains the requested file", path: "wanted.ts", cursor: null },
    { name: "ends before a newly added file", path: "other.ts", cursor: null },
    { name: "has an obsolete next cursor", path: "other.ts", cursor: "old-next" },
  ])("waits for a cached page that $name to settle", async ({ path, cursor }) => {
    using context = setup();
    const registry = context.registry;
    const first = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
      AsyncResult.success(page(path, "STALE", cursor), { waiting: true }),
    );
    state.pages.set(null, first);
    state.pages.set(
      "old-next",
      Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(AsyncResult.initial(true)),
    );
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <Probe wantedPaths={["wanted.ts"]} />
      </RegistryContext.Provider>,
    );
    const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
    expect(result()).toEqual({ loading: true, files: [] });

    await act(() => registry.set(first, AsyncResult.success(page("wanted.ts", "FRESH", null))));
    expect(result()).toEqual({ loading: false, files: [["wanted.ts", "FRESH"]] });
  });
});
