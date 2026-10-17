import type { DesktopCustomBuildState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CustomBuildSettingsRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const act = bridge?.customBuildUpdate;
  const subscribe = bridge?.onCustomBuildState;
  const [state, setState] = useState<DesktopCustomBuildState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!act) return;
    let cancelled = false;
    const receive = (next: DesktopCustomBuildState) => {
      if (!cancelled) setState(next);
    };
    const unsubscribe = subscribe?.(receive);
    void act("state")
      .then(receive)
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [act, subscribe]);

  const change = (checkAgain = false) => {
    if (!act || !state || pending) return;
    setPending(true);
    const action = checkAgain
      ? "check"
      : state.status === "downloaded"
        ? "install"
        : state.status === "available"
          ? "download"
          : "check";
    const run = async () => {
      if (
        action === "install" &&
        !(await ensureLocalApi().dialogs.confirm(
          `Install custom build ${state.availableBuild}? T3 Code will close and open the Windows installer. Running agents will be interrupted.`,
        ))
      )
        return;
      setState(await act(action));
    };
    void run()
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Custom build update failed",
            description: error instanceof Error ? error.message : "Try again.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!act || !state?.supported) return null;
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const labels: Record<DesktopCustomBuildState["status"], string> = {
    idle: "Check for Custom Build",
    checking: "Checking…",
    available: "Download Custom Build",
    downloading: "Downloading…",
    downloaded: "Install Custom Build",
    installing: "Installing…",
    "up-to-date": "Check for Custom Build",
  };
  const description =
    state.message ??
    (state.status === "up-to-date"
      ? "No newer custom Windows build is available."
      : state.availableBuild
        ? `Custom build ${state.availableBuild}. Nightly updates remain separate.`
        : `Releases from AndreiShenets/t3code.${state.currentBuild ? ` Installed: ${state.currentBuild}.` : ""} Nightly updates remain separate.`);

  return (
    <SettingsRow
      {...searchableSetting("custom-build")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.status === "available" || state.status === "downloaded" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || busy}
              onClick={() => change(true)}
            >
              Check Again
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={pending || busy} onClick={() => change()}>
            {labels[state.status]}
          </Button>
        </div>
      }
    />
  );
}
