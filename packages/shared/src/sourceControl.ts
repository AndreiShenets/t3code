import type { PullRequestActor } from "@t3tools/contracts";

export function getPullRequestActorName(
  actor: Pick<PullRequestActor, "login" | "name"> | null | undefined,
  fallback = "ghost",
): string {
  return actor?.name?.trim() || actor?.login || fallback;
}

const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return SCP_SSH_REMOTE_PATTERN.test(trimmed) || trimmed.toLowerCase().startsWith("ssh://");
}
