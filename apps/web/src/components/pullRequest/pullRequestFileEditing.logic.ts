import type {
  EnvironmentId,
  ProjectId,
  RepositoryIdentity,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import { legacyThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";

interface FileProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

export function resolvePullRequestFileWorkspace({
  environmentId,
  reference,
  projects,
  thread,
}: {
  environmentId: EnvironmentId;
  reference: { projectId: ProjectId; repository: string; number: number; url: string };
  projects: ReadonlyArray<FileProject>;
  thread: {
    ref: ScopedThreadRef;
    projectId: ProjectId;
    worktreePath: string | null;
  } | null;
}) {
  const key = legacyThreadPullRequestKey(reference);
  const repositoryKey = canonicalRepositoryKey(`${key.host}/${key.repository}`);
  const matches = projects.filter((project) => {
    if (project.environmentId !== environmentId || !project.workspaceRoot) return false;
    const identity = project.repositoryIdentity;
    return (
      identity !== undefined &&
      identity !== null &&
      [identity.canonicalKey, identity.origin?.canonicalKey].some(
        (candidate) =>
          candidate !== undefined &&
          canonicalRepositoryKey(candidate.toLowerCase()) === repositoryKey,
      )
    );
  });
  const project =
    matches.find(
      (candidate) =>
        thread?.ref.environmentId === environmentId && candidate.id === thread.projectId,
    ) ??
    matches.find((candidate) => candidate.id === reference.projectId) ??
    matches[0];
  if (!project) return null;
  const matchingThread =
    thread?.ref.environmentId === environmentId && thread.projectId === project.id ? thread : null;
  const worktreePath = matchingThread?.worktreePath;
  return {
    environmentId,
    workspaceRoot: worktreePath ?? project.workspaceRoot,
    repositoryRoot: worktreePath ? undefined : project.repositoryIdentity?.rootPath,
    threadRef: matchingThread?.ref ?? null,
  };
}
