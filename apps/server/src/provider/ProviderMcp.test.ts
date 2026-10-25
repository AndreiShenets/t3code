import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderMcp from "./ProviderMcp.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const instanceId = ProviderInstanceId.make("opencode-personal");
const otherInstanceId = ProviderInstanceId.make("opencode-work");
const target = { instanceId, cwd: "/worktree" };

function instance(
  overrides: Pick<ProviderInstance, "enabled"> & Partial<Pick<ProviderInstance, "mcpManagement">>,
): ProviderInstance {
  return {
    instanceId,
    driverKind: ProviderDriverKind.make("opencode"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("opencode"),
      continuationKey: instanceId,
    },
    displayName: undefined,
    get snapshot(): never {
      throw new Error("MCP management must not refresh settings or snapshots.");
    },
    get orchestrationAdapter(): never {
      throw new Error("MCP management must not start an agent turn.");
    },
    get textGeneration(): never {
      throw new Error("MCP management must not generate text.");
    },
    ...overrides,
  };
}

function layer(instances: ReadonlyMap<ProviderInstanceId, ProviderInstance>) {
  return ProviderMcp.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(instances.get(id)),
      }),
    ),
  );
}

describe("ProviderMcp", () => {
  it.effect("routes runtime changes to the selected instance and workspace", () => {
    const state = new Map<string, boolean>();
    const management: NonNullable<ProviderInstance["mcpManagement"]> = {
      list: (cwd) =>
        Effect.succeed({
          servers: [{ name: "context7", status: state.get(cwd) ? "connected" : "disabled" }],
        }),
      setEnabled: ({ cwd, enabled }) =>
        Effect.gen(function* () {
          state.set(cwd, enabled);
          return yield* management.list(cwd);
        }),
    };
    const instances = new Map([
      [instanceId, instance({ enabled: true, mcpManagement: management })],
    ]);
    return Effect.gen(function* () {
      const mcp = yield* ProviderMcp.ProviderMcp;
      expect(
        (yield* mcp.setEnabled({ ...target, server: "context7", enabled: true })).servers[0]
          ?.status,
      ).toBe("connected");
      expect((yield* mcp.list({ ...target, cwd: "/other-worktree" })).servers[0]?.status).toBe(
        "disabled",
      );
      expect(
        (yield* mcp.list({ ...target, instanceId: otherInstanceId }).pipe(Effect.flip)).reason,
      ).toBe("unavailable");
      expect(
        (yield* mcp.setEnabled({ ...target, server: "context7", enabled: false })).servers[0]
          ?.status,
      ).toBe("disabled");
    }).pipe(Effect.provide(layer(instances)));
  });

  it.effect.each([false, true])(
    "rejects disabled or unsupported instances (enabled: %s)",
    (enabled) =>
      Effect.gen(function* () {
        const mcp = yield* ProviderMcp.ProviderMcp;
        const reason = enabled ? "unsupported" : "unavailable";
        expect((yield* mcp.list(target).pipe(Effect.flip)).reason).toBe(reason);
        expect(
          (yield* mcp
            .setEnabled({ ...target, server: "context7", enabled: true })
            .pipe(Effect.flip)).reason,
        ).toBe(reason);
      }).pipe(Effect.provide(layer(new Map([[instanceId, instance({ enabled })]])))),
  );
});
