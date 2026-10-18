import type { DesktopBridge, DesktopCustomBuildState } from "@t3tools/contracts";

const LABELS: Record<DesktopCustomBuildState["status"], string> = {
  idle: "Check for Custom Build",
  checking: "Checking…",
  available: "Download Custom Build",
  downloading: "Downloading…",
  downloaded: "Install Custom Build",
  installing: "Installing…",
  "up-to-date": "Check for Custom Build",
};

export function customBuildUpdatePresentation(
  state: DesktopCustomBuildState | null,
  pending: boolean,
) {
  const status = state?.status ?? "idle";
  const busy = ["checking", "downloading", "installing"].includes(status);
  return {
    visible: state?.supported === true,
    disabled: pending || busy || !state?.supported,
    busy,
    iconStatus: status === "up-to-date" ? "idle" : status === "installing" ? "downloaded" : status,
    label: LABELS[status],
    description:
      state?.message ??
      (status === "up-to-date"
        ? "No newer custom Windows build is available."
        : state?.availableBuild
          ? `Custom build ${state.availableBuild}. Nightly updates remain separate.`
          : `Releases from AndreiShenets/t3code.${state?.currentBuild ? ` Installed: ${state.currentBuild}.` : ""} Nightly updates remain separate.`),
  };
}

export async function performCustomBuildUpdate({
  state,
  act,
  confirm,
  checkAgain = false,
}: {
  state: DesktopCustomBuildState;
  act: NonNullable<DesktopBridge["customBuildUpdate"]>;
  confirm: (message: string) => Promise<boolean>;
  checkAgain?: boolean;
}) {
  if (customBuildUpdatePresentation(state, false).disabled) return null;
  const action = checkAgain
    ? "check"
    : state.status === "downloaded"
      ? "install"
      : state.status === "available"
        ? "download"
        : "check";
  if (
    action === "install" &&
    !(await confirm(
      `Install custom build ${state.availableBuild}? T3 Code will close and open the Windows installer. Running agents will be interrupted.`,
    ))
  )
    return null;
  return act(action);
}
