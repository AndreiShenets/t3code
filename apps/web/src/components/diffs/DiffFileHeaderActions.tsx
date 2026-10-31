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
  onOpenFile,
  editorAction,
}: {
  filePath: string;
  onOpenFile?: ((path: string) => void) | undefined;
  editorAction?: DiffFileEditorAction | null | undefined;
}) {
  return (
    <>
      <DiffFilePathCopyButton filePath={filePath} />
      {onOpenFile ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label="Open file"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenFile(filePath);
                }}
              />
            }
          >
            <FilePenLine className="size-3" />
          </TooltipTrigger>
          <TooltipPopup>Open file in current checkout</TooltipPopup>
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
