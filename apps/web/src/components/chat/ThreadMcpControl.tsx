import { MCP_WORKSPACE_NOTICE, supportsMcpManagement } from "@t3tools/client-runtime/mcpCommands";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { McpServerList } from "./McpServerControls";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const LIST_COMMAND = { action: "list" } as const;

export function ThreadMcpControl(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider | null;
  readonly cwd: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (!supportsMcpManagement(props.provider) || !props.provider || !props.cwd) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<ThreadDetailsControl part="select" />}>
        <PlugIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="flex-1">MCP</span>
      </PopoverTrigger>
      <PopoverPopup side="left" align="start" width="lg">
        <div className="space-y-4">
          <PopoverTitle>Configured MCP servers</PopoverTitle>
          <p className="text-xs text-muted-foreground">{MCP_WORKSPACE_NOTICE}</p>
          {open ? (
            <McpServerList
              environmentId={props.environmentId}
              target={{ instanceId: props.provider.instanceId, cwd: props.cwd }}
              command={LIST_COMMAND}
            />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
