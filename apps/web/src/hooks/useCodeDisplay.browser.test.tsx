import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type ProjectReadFileResult,
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type FileResult = AsyncResult.AsyncResult<ProjectReadFileResult, Error>;
type SnapshotResult = AsyncResult.AsyncResult<PullRequestDiffFileContentsResult, Error>;
type SnapshotTarget = { environmentId: EnvironmentId; input: PullRequestDiffFileContentsInput };
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  responses: new Map<string, FileResult>(),
  reads: [] as string[],
  snapshots: new Map<string, SnapshotResult>(),
  snapshotReads: [] as SnapshotTarget[],
  canReadFiles: true,
  showWhitespace: false,
  displayRenders: 0,
}));

vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: state.canReadFiles }),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: { showWhitespace: boolean }) => boolean) =>
    select({ showWhitespace: state.showWhitespace }),
}));
vi.mock("~/state/projects", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const files = Atom.family((key: string) =>
    Atom.make(() => {
      state.reads.push(key);
      return state.responses.get(key) ?? AsyncResult.failure(Cause.fail(new Error("Missing file")));
    }),
  );
  const optimistic = Atom.make(null);
  return {
    projectEnvironment: {
      readFile: (target: { environmentId: string; input: { cwd: string; relativePath: string } }) =>
        files(JSON.stringify([target.environmentId, target.input.cwd, target.input.relativePath])),
      optimisticFile: () => optimistic,
    },
  };
});

function snapshotKey({ environmentId, input }: SnapshotTarget) {
  return JSON.stringify([
    environmentId,
    input.projectId,
    input.host,
    input.repository,
    input.number,
    input.commit,
    input.newPath,
  ]);
}

vi.mock("~/state/pullRequests", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const files = Atom.family((key: string) =>
    Atom.make(() => {
      const target: SnapshotTarget = JSON.parse(key);
      state.snapshotReads.push(target);
      return (
        state.snapshots.get(snapshotKey(target)) ??
        AsyncResult.failure(Cause.fail(new Error("Missing snapshot file")))
      );
    }).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
  return {
    pullRequestEnvironment: {
      diffFileContentsQuery: (target: SnapshotTarget) => files(JSON.stringify(target)),
    },
  };
});

import { projectEnvironment } from "~/state/projects";
import { useCodeDisplay, type CodeDisplayWorkspace } from "./useCodeDisplay";

const environmentId = EnvironmentId.make("remote");
const workspace = { environmentId, cwd: "/repo" };

function putConfig(
  target: CodeDisplayWorkspace,
  relativePath: string,
  contents: string,
  truncated = false,
) {
  state.responses.set(
    JSON.stringify([target.environmentId, target.cwd, relativePath]),
    AsyncResult.success({
      relativePath,
      contents,
      byteLength: contents.length,
      truncated,
    }),
  );
}

function container() {
  const element = document.createElement("div");
  element.attachShadow({ mode: "open" }).innerHTML = "<div data-line>\tconst value = 1;</div>";
  return element;
}

function Surface({
  target,
  paths,
  element,
}: {
  target: CodeDisplayWorkspace | null;
  paths: string[];
  element: HTMLElement;
}) {
  const { onPostRender } = useCodeDisplay(target, paths);
  useLayoutEffect(() => {
    state.displayRenders++;
    onPostRender(element, paths[0] ?? "", "update");
  }, [element, onPostRender, paths]);
  return null;
}

function display(target: CodeDisplayWorkspace | null, paths: string[], element: HTMLElement) {
  return (
    <RegistryContext.Provider value={state.registry!}>
      <Surface target={target} paths={paths} element={element} />
    </RegistryContext.Provider>
  );
}

function setup() {
  const registry = AtomRegistry.make();
  state.registry = registry;
  state.responses = new Map();
  state.reads = [];
  state.snapshots = new Map();
  state.snapshotReads = [];
  state.canReadFiles = true;
  state.showWhitespace = false;
  state.displayRenders = 0;
  return { [Symbol.dispose]: () => registry.dispose() };
}

describe("pull request code display", () => {
  const target = {
    ...workspace,
    snapshot: {
      reference: {
        projectId: ProjectId.make("project"),
        host: "github.com",
        repository: "acme/repo",
        number: 1,
      },
      commit: "reviewed-head",
    },
  };
  function putConfigAtRevision(source: typeof target, path: string, contents: string) {
    state.snapshots.set(
      snapshotKey({
        environmentId: source.environmentId,
        input: {
          ...source.snapshot.reference,
          commit: source.snapshot.commit,
          changeType: "new",
          oldPath: path,
          newPath: path,
        },
      }),
      AsyncResult.success({ oldContents: "[*]\ntab_width = 12", newContents: contents }),
    );
  }

  it("reads the reviewed snapshot, shares ancestor reads, and never leaves the repository", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "[*]\ntab_width = 2");
    putConfigAtRevision(target, ".editorconfig", "[*]\ntab_width = 4");
    putConfigAtRevision(target, "src/.editorconfig", "[*.ts]\ntab_width = 8");
    state.canReadFiles = false;
    const element = container();
    await using screen = await render(display(target, ["src/app.ts", "src/other.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("8");
    expect(state.reads).toEqual([]);
    expect(state.snapshotReads.map(({ input }) => input.newPath)).toEqual([
      "src/.editorconfig",
      ".editorconfig",
    ]);
    for (const { environmentId, input } of state.snapshotReads) {
      expect(environmentId).toBe(target.environmentId);
      expect(input).toMatchObject({
        ...target.snapshot.reference,
        commit: "reviewed-head",
        changeType: "new",
        oldPath: input.newPath,
      });
    }
    await screen.rerender(display(target, ["README.md"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("4");
    expect(state.snapshotReads).toHaveLength(2);
  });

  it("isolates revisions, hosts, pull requests and environments", async () => {
    using _state = setup();
    const sources = [
      target,
      { ...target, snapshot: { ...target.snapshot, commit: "older-commit" } },
      {
        ...target,
        snapshot: {
          ...target.snapshot,
          reference: { ...target.snapshot.reference, host: "github.example.com" },
        },
      },
      {
        ...target,
        snapshot: { ...target.snapshot, reference: { ...target.snapshot.reference, number: 2 } },
      },
      { ...target, environmentId: EnvironmentId.make("other") },
    ];
    const element = container();
    await using screen = await render(null);
    for (const [index, source] of sources.entries()) {
      putConfigAtRevision(source, ".editorconfig", `[*]\ntab_width = ${index + 3}`);
      await screen.rerender(display(source, ["app.ts"], element));
      expect(element.style.getPropertyValue("--diffs-tab-size")).toBe(String(index + 3));
    }
    expect(state.snapshotReads).toHaveLength(sources.length);
    await screen.rerender(display(target, ["app.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("3");
    expect(state.snapshotReads).toHaveLength(sources.length);
  });

  it("reuses snapshots across navigation and remounts until explicitly refreshed", async () => {
    using _state = setup();
    const first = { ...target, mutationId: "details:refresh-1" };
    const second = { ...first, snapshot: { ...first.snapshot, commit: "another-commit" } };
    putConfigAtRevision(first, ".editorconfig", "[*]\ntab_width = 4");
    putConfigAtRevision(second, ".editorconfig", "[*]\ntab_width = 8");
    const element = container();
    await using screen = await render(null);
    for (const [source, width] of [
      [first, "4"],
      [second, "8"],
      [first, "4"],
    ] as const) {
      await screen.rerender(display(source, ["app.ts"], element));
      expect(element.style.getPropertyValue("--diffs-tab-size")).toBe(width);
    }
    expect(state.snapshotReads).toHaveLength(2);
    await screen.unmount();
    await using remounted = await render(display(first, ["app.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("4");
    expect(state.snapshotReads).toHaveLength(2);

    putConfigAtRevision(first, ".editorconfig", "[*]\ntab_width = 6");
    await remounted.rerender(
      display({ ...first, mutationId: "details:refresh-2" }, ["app.ts"], element),
    );
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("6");
    expect(state.snapshotReads).toHaveLength(3);
  });

  it("uses defaults when a snapshot is unavailable instead of the local configuration", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "[*]\ntab_width = 8");
    const element = container();
    await using screen = await render(display(target, ["app.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("2");
    await screen.rerender(
      display({ ...target, snapshot: { ...target.snapshot, commit: null } }, ["app.ts"], element),
    );
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("2");
    expect(state.snapshotReads).toHaveLength(1);
    expect(state.reads).toEqual([]);
  });

  it("refreshes failed snapshot reads through the existing view refresh signal", async () => {
    using _state = setup();
    const element = container();
    await using screen = await render(display(target, ["app.ts"], element));
    putConfigAtRevision(target, ".editorconfig", "[*]\nindent_size = 6");
    await screen.rerender(display({ ...target, mutationId: "refresh" }, ["app.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("6");
    expect(state.snapshotReads).toHaveLength(2);
    expect(state.reads).toEqual([]);
  });
});

describe("workspace code display", () => {
  it("does not rerender code when refreshed configuration resolves to the same widths", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 4");
    const element = container();
    await using _screen = await render(display(workspace, ["app.ts"], element));
    expect(state.displayRenders).toBe(1);
    const query = projectEnvironment.readFile({
      environmentId,
      input: { cwd: workspace.cwd, relativePath: ".editorconfig" },
    });
    putConfig(workspace, ".editorconfig", "root = true\n[*]\nindent_size = 4");
    await act(() => state.registry!.refresh(query));
    expect(state.displayRenders).toBe(1);
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("4");

    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 8");
    await act(() => state.registry!.refresh(query));
    expect(state.displayRenders).toBe(2);
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("8");
  });

  it("shares configuration reads across files and stops at root=true", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 4\n[*.md]\ntab_width = 6");
    const element = container();
    await using screen = await render(
      display(workspace, ["src/app.ts", "src/other.ts", "README.md"], element),
    );
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("4");
    expect(state.reads).toEqual([
      JSON.stringify([environmentId, "/repo", "src/.editorconfig"]),
      JSON.stringify([environmentId, "/repo", ".editorconfig"]),
    ]);

    await screen.rerender(display(workspace, ["README.md"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("6");
    expect(state.reads).toHaveLength(2);
  });

  it("isolates identical paths across environments and worktrees", async () => {
    using _state = setup();
    const otherEnvironment = { ...workspace, environmentId: EnvironmentId.make("local") };
    const otherWorktree = { ...workspace, cwd: "/repo-feature" };
    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 4");
    putConfig(otherEnvironment, ".editorconfig", "root = true\n[*]\ntab_width = 6");
    putConfig(otherWorktree, ".editorconfig", "root = true\n[*]\ntab_width = 8");
    const element = container();
    await using screen = await render(null);
    for (const [target, width] of [
      [workspace, "4"],
      [otherEnvironment, "6"],
      [otherWorktree, "8"],
    ] as const) {
      await screen.rerender(display(target, ["app.ts"], element));
      expect(element.style.getPropertyValue("--diffs-tab-size")).toBe(width);
    }
  });

  it("does not read past a pending config that may define root=true", async () => {
    using _state = setup();
    const key = JSON.stringify([environmentId, "/repo", ".editorconfig"]);
    state.responses.set(key, AsyncResult.initial());
    const element = container();
    await using _screen = await render(display(workspace, ["app.ts"], element));
    expect(state.reads).toEqual([key]);
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("2");

    putConfig(workspace, ".editorconfig", "root = true\n[*]\nindent_size = 4");
    await act(() =>
      state.registry!.refresh(
        projectEnvironment.readFile({
          environmentId,
          input: { cwd: "/repo", relativePath: ".editorconfig" },
        }),
      ),
    );
    expect(state.reads).toEqual([key, key]);
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("4");
  });

  it("refreshes after workspace mutations and toggles markers without changing copied text", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 4");
    const element = container();
    const original = element.shadowRoot!.textContent;
    await using screen = await render(display(workspace, ["app.ts"], element));
    expect(element.shadowRoot!.querySelector("[data-code-whitespace]")).toBeNull();

    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 8");
    state.showWhitespace = true;
    await screen.rerender(
      display({ ...workspace, mutationId: "agent-write" }, ["app.ts"], element),
    );
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("8");
    expect(element.shadowRoot!.querySelector('[data-code-whitespace="tab"]')).not.toBeNull();
    expect(element.shadowRoot!.textContent).toBe(original);

    state.showWhitespace = false;
    await screen.rerender(
      display({ ...workspace, mutationId: "agent-write" }, ["app.ts"], element),
    );
    expect(element.shadowRoot!.querySelector("[data-code-whitespace]")).toBeNull();
    expect(element.shadowRoot!.textContent).toBe(original);
    expect(state.reads).toHaveLength(2);
  });

  it("falls back for absent, unreadable, or truncated configurations", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 8", true);
    state.responses.set(
      JSON.stringify([environmentId, "/repo", "/.editorconfig"]),
      AsyncResult.failure(Cause.fail(new Error("Denied"))),
    );
    const element = container();
    await using _screen = await render(display(workspace, ["app.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("2");
  });

  it("drops a deleted configuration even when the query retains its previous success", async () => {
    using _state = setup();
    putConfig(workspace, ".editorconfig", "root = true\n[*]\ntab_width = 8");
    putConfig(workspace, "/.editorconfig", "root = true\n[*]\nindent_size = 4");
    const element = container();
    await using screen = await render(display(workspace, ["app.ts"], element));
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("8");
    const key = JSON.stringify([environmentId, "/repo", ".editorconfig"]);
    state.responses.set(
      key,
      AsyncResult.failureWithPrevious(Cause.fail(new Error("Missing file")), {
        previous: Option.some(state.responses.get(key)!),
      }),
    );
    await screen.rerender(
      display({ ...workspace, mutationId: "delete-config" }, ["app.ts"], element),
    );
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("4");
  });

  it("makes no file requests for denied access or captured attachments", async () => {
    using _state = setup();
    const element = container();
    state.canReadFiles = false;
    await using screen = await render(display(workspace, ["app.ts"], element));
    state.canReadFiles = true;
    state.showWhitespace = true;
    await screen.rerender(display(null, ["attachment.ts"], element));
    expect(state.reads).toEqual([]);
    expect(element.style.getPropertyValue("--diffs-tab-size")).toBe("2");
    expect(element.shadowRoot!.querySelector('[data-code-whitespace="tab"]')).not.toBeNull();
  });
});
