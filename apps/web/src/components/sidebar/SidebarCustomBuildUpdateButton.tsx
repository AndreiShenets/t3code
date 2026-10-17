import { DownloadIcon, HourglassIcon, PackageCheckIcon, PackageSearchIcon } from "lucide-react";

import { useCustomBuildUpdate } from "../../hooks/useCustomBuildUpdate";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarCustomBuildUpdateButton() {
  const { state, visible, disabled, busy, label, description, change } = useCustomBuildUpdate();
  if (!visible) return null;
  const Icon = busy
    ? HourglassIcon
    : state?.status === "downloaded"
      ? PackageCheckIcon
      : state?.status === "available"
        ? DownloadIcon
        : PackageSearchIcon;

  return (
    <div className="mr-1 shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              size="icon"
              aria-label={busy ? `Custom build: ${label}` : label}
              aria-busy={busy}
              disabled={disabled}
              isActive={state?.status === "available" || state?.status === "downloaded"}
              onClick={() => change()}
            >
              <Icon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          <div>{busy ? `Custom build: ${label}` : label}</div>
          <div>{description}</div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
