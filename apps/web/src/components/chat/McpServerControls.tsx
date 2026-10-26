import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  MCP_WORKSPACE_NOTICE,
  type McpCommand,
  type McpManagementRequest,
} from "@t3tools/client-runtime/mcpCommands";
import type { ProviderMcpServer } from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function McpServerList(props: McpManagementRequest) {
  const registry = useContext(RegistryContext);
  const canManage = useAtomValue(
    serverEnvironment.setMcpEnabled.permissionAtom(props.environmentId),
  );
  const [servers, setServers] = useState<ReadonlyArray<ProviderMcpServer>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [query, setQuery] = useState("");
  const requestId = useRef(0);
  const { environmentId, target, command } = props;

  const run = async (next: Exclude<McpCommand, { action: "invalid" }>) => {
    const id = ++requestId.current;
    const result = await (next.action === "list"
      ? serverEnvironment.listMcpServers.run(registry, { environmentId, input: target })
      : serverEnvironment.setMcpEnabled.run(registry, {
          environmentId,
          input: { ...target, server: next.server, enabled: next.enabled },
        }));
    if (requestId.current !== id) return;
    if (result._tag === "Success") setServers(result.value.servers);
    else if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    setBusy(false);
  };
  const runStable = useStableCallback(run);
  const start = (next: Exclude<McpCommand, { action: "invalid" }>) => {
    setBusy(true);
    setError(null);
    void run(next);
  };

  useEffect(() => {
    void runStable(command);
    return () => {
      requestId.current++;
    };
  }, [runStable, command]);

  const visible = servers.filter((server) =>
    server.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="space-y-4">
      <p className="break-all text-xs text-muted-foreground">{target.cwd}</p>
      <Input
        aria-label="Search MCP servers"
        placeholder="Search servers…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          start({ action: "list" });
        }}
      >
        Refresh
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          Updating MCP connections…
        </p>
      ) : null}
      {!busy && !error && visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {servers.length ? "No matching servers." : "No configured MCP servers in this workspace."}
        </p>
      ) : null}
      {visible.map((server) => (
        <div key={server.name} className="flex items-center justify-between gap-3">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              server.status === "connected"
                ? "bg-success"
                : server.status === "failed" || server.status === "needs-auth"
                  ? "bg-warning"
                  : "bg-muted-foreground/40",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="break-all text-sm font-medium">{server.name}</p>
            <p className="text-xs text-muted-foreground">
              {server.status === "needs-auth"
                ? "Needs authentication. Sign in using OpenCode /mcps."
                : server.status}
            </p>
          </div>
          <Switch
            size="sm"
            aria-label={`Enable ${server.name}`}
            checked={server.status !== "disabled"}
            disabled={busy || !canManage}
            onCheckedChange={(enabled) => {
              start({
                action: "set-enabled",
                server: server.name,
                enabled,
              });
            }}
          />
        </div>
      ))}
      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          Provider management permission is required to change connections.
        </p>
      ) : null}
    </div>
  );
}

export function ComposerMcpDialog(props: McpManagementRequest & { readonly onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>MCP servers</DialogTitle>
          <DialogDescription>{MCP_WORKSPACE_NOTICE}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <McpServerList {...props} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
