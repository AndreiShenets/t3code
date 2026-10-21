import { ProviderMcpError } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import * as OpenCode2Server from "./OpenCode2Server.ts";

const isManagedServer = (name: string) => name === "t3-code" || name.startsWith("t3-code-");

export const make = Effect.gen(function* () {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const list = (cwd: string) =>
    server
      .withConnection(({ client }) =>
        client.mcp.list({ location: { directory: cwd } }).pipe(
          Effect.map(({ data }) => ({
            servers: data
              .filter((entry) => !isManagedServer(entry.name))
              .map((entry) => ({
                name: entry.name,
                status:
                  entry.status.status === "needs_auth"
                    ? ("needs-auth" as const)
                    : entry.status.status,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          })),
        ),
      )
      .pipe(
        Effect.timeout("40 seconds"),
        Effect.mapError((cause) => new ProviderMcpError({ reason: "request-failed", cause })),
      );

  return {
    list,
    setEnabled: Effect.fn("OpenCode2Mcp.setEnabled")(function* (input) {
      if (isManagedServer(input.server)) {
        return yield* new ProviderMcpError({ reason: "managed-server" });
      }
      yield* server
        .withConnection(({ client }) => {
          const request = { server: input.server, location: { directory: input.cwd } };
          return input.enabled ? client.mcp.connect(request) : client.mcp.disconnect(request);
        })
        .pipe(
          Effect.timeout("40 seconds"),
          Effect.mapError((cause) => new ProviderMcpError({ reason: "request-failed", cause })),
        );
      return yield* list(input.cwd);
    }),
  } satisfies NonNullable<ProviderInstance["mcpManagement"]>;
});
