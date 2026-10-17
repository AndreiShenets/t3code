import { useAtom } from "@effect/atom-react";
import type { DesktopCustomBuildState } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import {
  customBuildUpdatePresentation,
  performCustomBuildUpdate,
} from "../components/customBuildUpdate.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { ensureLocalApi } from "../localApi";

const pendingAtom = Atom.make(false);

export function useCustomBuildUpdate() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const act = bridge?.customBuildUpdate;
  const subscribe = bridge?.onCustomBuildState;
  const [state, setState] = useState<DesktopCustomBuildState | null>(null);
  const [pending, setPending] = useAtom(pendingAtom);

  useEffect(() => {
    if (!act) return;
    let cancelled = false;
    let receivedEvent = false;
    const receive = (next: DesktopCustomBuildState) => {
      if (!cancelled) setState(next);
    };
    const unsubscribe = subscribe?.((next) => {
      receivedEvent = true;
      receive(next);
    });
    void act("state")
      .then((next) => {
        if (!receivedEvent) receive(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [act, subscribe]);

  const presentation = customBuildUpdatePresentation(state, pending);
  const reportError = (description: string) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Custom build update failed", description }),
    );
  };
  const change = (checkAgain = false) => {
    if (!act || !state || presentation.disabled) return;
    setPending(true);
    void performCustomBuildUpdate({
      state,
      act,
      confirm: (message) => ensureLocalApi().dialogs.confirm(message),
      checkAgain,
    })
      .then((next) => {
        if (!next) return;
        setState(next);
        if (next.message) reportError(next.message);
      })
      .catch((error: unknown) => {
        reportError(error instanceof Error ? error.message : "Try again.");
      })
      .finally(() => setPending(false));
  };

  return { state, ...presentation, change };
}
