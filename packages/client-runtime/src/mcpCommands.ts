import type { EnvironmentId, ProviderMcpTarget, ServerProvider } from "@t3tools/contracts";

export type McpCommand =
  | { readonly action: "list" }
  | { readonly action: "set-enabled"; readonly server: string; readonly enabled: boolean }
  | { readonly action: "invalid" };

export interface McpManagementRequest {
  readonly environmentId: EnvironmentId;
  readonly target: ProviderMcpTarget;
  readonly command: Exclude<McpCommand, { action: "invalid" }>;
}

export const MCP_COMMAND_USAGE =
  "Use /mcp, /mcp list, /mcp enable <server>, or /mcp disable <server>.";
export const MCP_WORKSPACE_NOTICE =
  "Changes affect all sessions using this OpenCode workspace. They last until OpenCode reloads or restarts. No configuration files are changed.";

export function supportsMcpManagement(
  provider:
    | (Pick<ServerProvider, "driver"> & Partial<Pick<ServerProvider, "version" | "enabled">>)
    | null
    | undefined,
): boolean {
  return (
    provider?.enabled === true &&
    provider.driver === "opencode" &&
    (provider.version ?? "").startsWith("2.")
  );
}

export function parseMcpCommand(text: string): McpCommand | null {
  const command = text.trim();
  if (!/^\/mcp(?:\s|$)/i.test(command)) return null;
  if (/^\/mcp(?:\s+list)?$/i.test(command)) return { action: "list" };
  const match = /^\/mcp\s+(enable|disable)\s+(.+)$/i.exec(command);
  if (!match || /[\r\n]/.test(command)) return { action: "invalid" };
  return {
    action: "set-enabled",
    server: match[2]!.trim(),
    enabled: match[1]!.toLowerCase() === "enable",
  };
}
