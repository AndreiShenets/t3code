import { useEffect, useRef } from "react";

function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  /** Immutable snapshots only need refreshing after an explicit mutation while mounted. */
  readonly refreshOnResourceChange?: boolean;
  readonly refresh: () => void;
  readonly resourceKey: string;
}): void {
  const {
    enabled = true,
    mutationId,
    refresh,
    refreshOnResourceChange = true,
    resourceKey,
  } = input;
  const handledTokenRef = useRef<string | null>(null);
  const resourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const resourceChanged = resourceKeyRef.current !== resourceKey;
    resourceKeyRef.current = resourceKey;
    const token = workspaceMutationRefreshToken(resourceKey, mutationId);
    if (token === null || token === handledTokenRef.current) return;
    handledTokenRef.current = token;
    if (resourceChanged && !refreshOnResourceChange) return;
    refresh();
  }, [enabled, mutationId, refresh, refreshOnResourceChange, resourceKey]);
}
