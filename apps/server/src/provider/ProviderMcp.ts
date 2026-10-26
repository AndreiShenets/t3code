import {
  ProviderMcpError,
  type ProviderMcpListResult,
  type ProviderMcpTarget,
  type ProviderMcpSetEnabledInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

export class ProviderMcp extends Context.Service<
  ProviderMcp,
  {
    readonly list: (
      input: ProviderMcpTarget,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
    readonly setEnabled: (
      input: ProviderMcpSetEnabledInput,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
  }
>()("t3/provider/ProviderMcp") {}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const managementFor = Effect.fn("ProviderMcp.managementFor")(function* (
    input: ProviderMcpTarget,
  ) {
    const instance = yield* instances.getInstance(input.instanceId);
    if (!instance?.enabled) return yield* new ProviderMcpError({ reason: "unavailable" });
    if (!instance.mcpManagement) return yield* new ProviderMcpError({ reason: "unsupported" });
    return instance.mcpManagement;
  });
  return ProviderMcp.of({
    list: Effect.fn("ProviderMcp.list")(function* (input) {
      return yield* (yield* managementFor(input)).list(input.cwd);
    }),
    setEnabled: Effect.fn("ProviderMcp.setEnabled")(function* (input) {
      return yield* (yield* managementFor(input)).setEnabled(input);
    }),
  });
});

export const layer = Layer.effect(ProviderMcp, make);
