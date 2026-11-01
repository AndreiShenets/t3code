import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectReadFileResult,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
} from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { PostRenderPhase } from "@pierre/diffs";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { releaseCodeWhitespace, renderCodeWhitespace } from "~/lib/codeWhitespace";
import {
  DEFAULT_CODE_TAB_SIZE,
  editorConfigCandidates,
  parseEditorConfig,
  resolveEditorConfigTabSize,
} from "~/lib/editorConfig";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useClientSettings } from "./useSettings";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

export interface CodeDisplayWorkspace {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly mutationId?: string | null;
  /** A missing revision must not substitute the checkout for a hosted diff. */
  readonly snapshot?: { readonly reference: PullRequestRef; readonly commit: string | null };
}

export function renderCodeDisplay(
  container: HTMLElement,
  phase: PostRenderPhase,
  tabSize: number,
  showWhitespace: boolean,
) {
  if (phase === "unmount") {
    releaseCodeWhitespace(container);
    return;
  }
  if (container.style.getPropertyValue("--diffs-tab-size") !== String(tabSize)) {
    container.style.setProperty("--diffs-tab-size", String(tabSize));
  }
  renderCodeWhitespace(container, showWhitespace);
}

type ConfigFile = ProjectReadFileResult | PullRequestDiffFileContentsResult;
const parsedConfigs = new WeakMap<ConfigFile, ReturnType<typeof parseEditorConfig>>();

function parseConfig(file: ConfigFile) {
  let parsed = parsedConfigs.get(file);
  if (parsed === undefined) {
    parsed = parseEditorConfig(
      "contents" in file ? (file.truncated ? "" : file.contents) : file.newContents,
    );
    parsedConfigs.set(file, parsed);
  }
  return parsed;
}

/** Shares configuration reads in the file's environment and displayed revision. */
export function useCodeDisplay(
  workspace: CodeDisplayWorkspace | null | undefined,
  filePaths: ReadonlyArray<string>,
) {
  const showWhitespace = useClientSettings((settings) => settings.showWhitespace);
  const environmentId = workspace?.environmentId ?? null;
  const cwd = workspace?.cwd ?? null;
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const pathsKey = JSON.stringify(filePaths);
  const snapshotKey = JSON.stringify(workspace?.snapshot ?? null);
  const configs = (() => {
    const snapshot: NonNullable<CodeDisplayWorkspace["snapshot"]> | null = JSON.parse(snapshotKey);
    if (
      environmentId === null ||
      cwd === null ||
      (snapshot === null ? !canReadFiles : snapshot.commit === null)
    )
      return [];
    const paths: string[] = JSON.parse(pathsKey);
    return paths.map((filePath) => ({
      filePath,
      candidates: editorConfigCandidates(snapshot ? "/" : cwd, filePath).map((candidate) => {
        const relativePath = workspaceRelativeFilePath(candidate.path, cwd) ?? candidate.path;
        const query: Atom.Atom<AsyncResult.AsyncResult<ConfigFile, unknown>> = snapshot
          ? pullRequestEnvironment.diffFileContentsQuery({
              environmentId,
              input: {
                ...snapshot.reference,
                commit: snapshot.commit!,
                changeType: "new",
                oldPath: candidate.path.slice(1),
                newPath: candidate.path.slice(1),
              },
            })
          : projectEnvironment.readFile({ environmentId, input: { cwd, relativePath } });
        return {
          ...candidate,
          query,
          optimistic: snapshot
            ? null
            : projectEnvironment.optimisticFile({ environmentId, cwd, relativePath }),
        };
      }),
    }));
  })();
  const displayAtom = Atom.make((get) => {
    const queries = new Set<Atom.Atom<unknown>>();
    const tabSizes = new Map<string, number>();
    for (const { filePath, candidates } of configs) {
      const applicable = [];
      for (const candidate of candidates) {
        queries.add(candidate.query);
        const result = get(candidate.query);
        const file =
          (candidate.optimistic === null ? null : get(candidate.optimistic)?.data) ??
          (result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result)));
        // Wait for each directory before walking farther so root=true is an actual boundary.
        if (file === null && result._tag === "Initial") break;
        if (file === null) continue;
        const config = parseConfig(file);
        applicable.push({ config, relativeFilePath: candidate.relativeFilePath });
        if (config.root) break;
      }
      const tabSize = resolveEditorConfigTabSize(applicable);
      if (tabSize !== DEFAULT_CODE_TAB_SIZE) tabSizes.set(filePath, tabSize);
    }
    return { tabSizes, queries };
  });
  const display = useAtomValue(displayAtom);
  const widthsKey = JSON.stringify([...display.tabSizes].sort(([a], [b]) => a.localeCompare(b)));
  // Query refreshes can return equivalent data; keep Pierre's render callback stable then.
  const tabSizes = new Map<string, number>(JSON.parse(widthsKey));
  useWorkspaceMutationRefresh({
    mutationId: workspace?.mutationId ?? null,
    refreshOnResourceChange: workspace?.snapshot === undefined,
    resourceKey: JSON.stringify([environmentId, cwd, snapshotKey]),
    refresh: () => {
      for (const query of display.queries) appAtomRegistry.refresh(query);
    },
  });
  const onPostRender = (container: HTMLElement, filePath: string, phase: PostRenderPhase) =>
    renderCodeDisplay(
      container,
      phase,
      tabSizes.get(filePath) ?? DEFAULT_CODE_TAB_SIZE,
      showWhitespace,
    );
  return { onPostRender, tabSizes, showWhitespace };
}
