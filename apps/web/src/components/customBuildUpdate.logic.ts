import type { DesktopBridge, DesktopCustomBuildState } from "@t3tools/contracts";

import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";

const LABELS: Record<DesktopCustomBuildState["status"], string> = {
  idle: msg("Check for Custom Build"),
  checking: msg("Checking…"),
  available: msg("Download Custom Build"),
  downloading: msg("Downloading…"),
  downloaded: msg("Install Custom Build"),
  installing: msg("Installing…"),
  "up-to-date": msg("Check for Custom Build"),
};

export function customBuildUpdatePresentation(
  state: DesktopCustomBuildState | null,
  pending: boolean,
  resolve: MessageResolver = m,
) {
  const status = state?.status ?? "idle";
  const busy = ["checking", "downloading", "installing"].includes(status);
  return {
    visible: state?.supported === true,
    disabled: pending || busy || !state?.supported,
    busy,
    label: resolve(LABELS[status]),
    description:
      state?.message ??
      (status === "up-to-date"
        ? resolve(msg("No newer custom Windows build is available."))
        : state?.availableBuild
          ? resolve(msg("Custom build {build}.", { build: state.availableBuild }))
          : state?.currentBuild
            ? resolve(
                msg("Releases from AndreiShenets/t3code. Installed: {build}.", {
                  build: state.currentBuild,
                }),
              )
            : resolve(msg("Releases from AndreiShenets/t3code."))),
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
      m(
        msg(
          "Install custom build {build}? T3 Code will close and open the Windows installer. Running agents will be interrupted.",
          { build: state.availableBuild ?? "" },
        ),
      ),
    ))
  )
    return null;
  return act(action);
}
