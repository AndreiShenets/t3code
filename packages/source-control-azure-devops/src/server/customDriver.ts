import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as PullRequests from "./AzureDevOpsServerPullRequestProvider.ts";
import * as SourceControl from "./AzureDevOpsServerSourceControlProvider.ts";
import * as Client from "./AzureDevOpsServerClient.ts";
import { definition } from "../shared/customDefinition.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(
    Effect.all({
      sourceControl: SourceControl.make,
      discovery: SourceControl.makeDiscovery,
      pullRequests: PullRequests.make,
    }),
    Client.layer,
  ),
});
