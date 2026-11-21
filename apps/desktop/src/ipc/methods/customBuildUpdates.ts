import { DesktopCustomBuildActionSchema, DesktopCustomBuildStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopCustomBuildUpdates from "../../updates/DesktopCustomBuildUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const customBuildUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CUSTOM_BUILD_ACTION_CHANNEL,
  payload: DesktopCustomBuildActionSchema,
  result: DesktopCustomBuildStateSchema,
  handler: Effect.fn("desktop.ipc.customBuildUpdate")(function* (action) {
    const updates = yield* DesktopCustomBuildUpdates.DesktopCustomBuildUpdates;
    return yield* updates.act(action);
  }),
});
