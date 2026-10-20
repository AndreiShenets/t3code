import { FilePenLine } from "lucide-react";

import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function DiffFileHeaderActions({
  filePath,
  onOpenFile,
}: {
  filePath: string;
  onOpenFile?: ((path: string) => void) | undefined;
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
    </>
  );
}
