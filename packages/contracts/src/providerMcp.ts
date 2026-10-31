import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderMcpTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
});
export type ProviderMcpTarget = typeof ProviderMcpTarget.Type;

export const ProviderMcpSetEnabledInput = Schema.Struct({
  ...ProviderMcpTarget.fields,
  server: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderMcpSetEnabledInput = typeof ProviderMcpSetEnabledInput.Type;

export const ProviderMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["connected", "disabled", "pending", "failed", "needs-auth"]),
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderMcpListResult = Schema.Struct({
  servers: Schema.Array(ProviderMcpServer),
});
export type ProviderMcpListResult = typeof ProviderMcpListResult.Type;

export class ProviderMcpError extends Schema.TaggedError<ProviderMcpError>()("ProviderMcpError", {
  reason: Schema.Literals(["unavailable", "unsupported", "managed-server", "request-failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "This provider instance is unavailable or disabled.";
      case "unsupported":
        return "MCP management requires OpenCode V2.";
      case "managed-server":
        return "T3 Code manages its own MCP connection automatically.";
      case "request-failed":
        return "OpenCode could not update or list MCP connections. Check the provider connection and try again.";
    }
  }
}
