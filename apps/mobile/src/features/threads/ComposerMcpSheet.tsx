import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { MCP_WORKSPACE_NOTICE, type McpCommand } from "@t3tools/client-runtime/mcpCommands";
import type { EnvironmentId, ProviderMcpServer, ProviderMcpTarget } from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function ComposerMcpSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly target: ProviderMcpTarget;
  readonly command: Exclude<McpCommand, { action: "invalid" }>;
  readonly onClose: () => void;
}) {
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
  const run = useCallback(
    (next: Exclude<McpCommand, { action: "invalid" }>) => {
      const id = ++requestId.current;
      const request =
        next.action === "list"
          ? serverEnvironment.listMcpServers.run(registry, { environmentId, input: target })
          : serverEnvironment.setMcpEnabled.run(registry, {
              environmentId,
              input: { ...target, server: next.server, enabled: next.enabled },
            });
      return request.then((result) => {
        if (requestId.current !== id) return;
        if (result._tag === "Success") setServers(result.value.servers);
        else if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
        setBusy(false);
      });
    },
    [registry, environmentId, target],
  );
  const start = (next: Exclude<McpCommand, { action: "invalid" }>) => {
    setBusy(true);
    setError(null);
    void run(next);
  };

  useEffect(() => {
    void run(command);
    return () => {
      requestId.current++;
    };
  }, [run, command]);

  const visible = servers.filter((server) =>
    server.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Sheet title="MCP servers" onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 p-4"
      >
        <Text className="text-sm text-foreground-muted">{MCP_WORKSPACE_NOTICE}</Text>
        <Text className="text-xs text-foreground-muted">{target.cwd}</Text>
        <TextInput
          accessibilityLabel="Search MCP servers"
          placeholder="Search servers…"
          value={query}
          onChangeText={setQuery}
          className="rounded-lg border border-border-subtle p-3 text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            start({ action: "list" });
          }}
          className="self-start rounded-lg bg-card px-4 py-2 disabled:opacity-50"
        >
          <Text className="text-sm text-foreground">Refresh</Text>
        </Pressable>
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger">
            {error}
          </Text>
        ) : null}
        {busy ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            Updating MCP connections…
          </Text>
        ) : null}
        {!busy && !error && visible.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            {servers.length
              ? "No matching servers."
              : "No configured MCP servers in this workspace."}
          </Text>
        ) : null}
        {visible.map((server) => (
          <View key={server.name} className="flex-row items-center gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium text-foreground">{server.name}</Text>
              <Text className="text-xs text-foreground-muted">
                {server.status === "needs-auth"
                  ? "Needs authentication — sign in using OpenCode /mcps."
                  : server.status}
              </Text>
            </View>
            <ThemedSwitch
              accessibilityLabel={`Enable ${server.name}`}
              value={server.status !== "disabled"}
              disabled={busy || !canManage}
              onValueChange={(enabled) => {
                start({
                  action: "set-enabled",
                  server: server.name,
                  enabled,
                });
              }}
            />
          </View>
        ))}
        {!canManage ? (
          <Text className="text-xs text-foreground-muted">
            Provider management permission is required to change connections.
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
