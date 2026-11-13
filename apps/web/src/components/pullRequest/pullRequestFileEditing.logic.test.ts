import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestFileWorkspace } from "./pullRequestFileEditing.logic";

const environmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const reference = {
  projectId,
  repository: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
};
const identity = {
  canonicalKey: "github.com/owner/repo",
  rootPath: "/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "git@github.com:owner/repo.git",
  },
};
const project = {
  id: projectId,
  environmentId,
  workspaceRoot: "/repo",
  repositoryIdentity: identity,
};
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));

describe("resolvePullRequestFileWorkspace", () => {
  it("uses the project checkout on the standalone PR page", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [project],
        thread: null,
      }),
    ).toEqual({
      environmentId,
      workspaceRoot: "/repo",
      repositoryRoot: "/repo",
      threadRef: null,
    });
  });

  it("uses the current thread worktree without switching branches", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [project],
        thread: { ref: threadRef, projectId, worktreePath: "/worktrees/current" },
      }),
    ).toEqual({
      environmentId,
      workspaceRoot: "/worktrees/current",
      repositoryRoot: undefined,
      threadRef,
    });
  });

  it("keeps the repository root for nested project checkouts", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [{ ...project, workspaceRoot: "/repo/frontend" }],
        thread: null,
      }),
    ).toMatchObject({ workspaceRoot: "/repo/frontend", repositoryRoot: "/repo" });
  });

  it("does not expose editing for an unrelated PR carried by an existing project", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference: {
          ...reference,
          repository: "other/repo",
          url: "https://github.com/other/repo/pull/42",
        },
        projects: [project],
        thread: null,
      }),
    ).toBeNull();
  });

  it("does not substitute a checkout from another environment or host", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [{ ...project, environmentId: remoteEnvironmentId }],
        thread: null,
      }),
    ).toBeNull();
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference: { ...reference, url: "https://github.example.com/owner/repo/pull/42" },
        projects: [project],
        thread: null,
      }),
    ).toBeNull();
  });

  it("finds a matching T3 project rather than using the carrier project's files", () => {
    const otherId = ProjectId.make("other");
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference: { ...reference, projectId: otherId },
        projects: [
          {
            ...project,
            id: otherId,
            repositoryIdentity: { ...identity, canonicalKey: "github.com/other/repo" },
          },
          project,
        ],
        thread: { ref: threadRef, projectId: otherId, worktreePath: "/other-worktree" },
      }),
    ).toMatchObject({ workspaceRoot: "/repo", threadRef: null });
  });

  it("prefers the current thread's matching checkout over another copy of the repository", () => {
    const threadProjectId = ProjectId.make("thread-project");
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [project, { ...project, id: threadProjectId, workspaceRoot: "/another-copy" }],
        thread: { ref: threadRef, projectId: threadProjectId, worktreePath: "/current-worktree" },
      }),
    ).toMatchObject({ workspaceRoot: "/current-worktree", threadRef });
  });

  it("matches repository identities case-insensitively", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [
          {
            ...project,
            repositoryIdentity: { ...identity, canonicalKey: "GitHub.com/Owner/Repo" },
          },
        ],
        thread: null,
      }),
    ).not.toBeNull();
  });

  it("allows a fork checkout associated with the upstream repository", () => {
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [
          {
            ...project,
            repositoryIdentity: {
              ...identity,
              canonicalKey: "github.com/fork/repo",
              origin: { canonicalKey: identity.canonicalKey },
            },
          },
        ],
        thread: null,
      }),
    ).toMatchObject({ workspaceRoot: "/repo" });
  });

  it("does not expose editing for a missing checkout or unknown repository identity", () => {
    expect(
      resolvePullRequestFileWorkspace({ environmentId, reference, projects: [], thread: null }),
    ).toBeNull();
    expect(
      resolvePullRequestFileWorkspace({
        environmentId,
        reference,
        projects: [{ ...project, repositoryIdentity: null }],
        thread: null,
      }),
    ).toBeNull();
  });
});
