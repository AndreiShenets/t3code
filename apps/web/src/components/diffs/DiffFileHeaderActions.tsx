import { useGT } from "gt-react";
import { FilePenLine } from "lucide-react";

import type { Icon } from "../Icons";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface DiffFileEditorAction {
  Icon: Icon;
  label: string;
  iconClassName: string;
  disabled: boolean;
  onOpen: () => void;
}

export function DiffFileHeaderActions({
  filePath,
  workspaceRoot,
  onOpenFile,
  editorAction,
}: {
  filePath: string;
  workspaceRoot?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  editorAction?: DiffFileEditorAction | null | undefined;
}) {
  const gt = useGT();
  return (
    <>
      <DiffFilePathCopyButton filePath={filePath} workspaceRoot={workspaceRoot} />
      {onOpenFile ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={gt("Open file")}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenFile(filePath);
                }}
              />
            }
          >
            <FilePenLine className="size-3" />
          </TooltipTrigger>
          <TooltipPopup>{gt("Open file in current checkout")}</TooltipPopup>
        </Tooltip>
      ) : null}
      {editorAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={editorAction.label}
                disabled={editorAction.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  editorAction.onOpen();
                }}
              />
            }
          >
            <editorAction.Icon
              aria-hidden="true"
              className={`size-3 ${editorAction.iconClassName}`}
            />
          </TooltipTrigger>
          <TooltipPopup>{editorAction.label}</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
