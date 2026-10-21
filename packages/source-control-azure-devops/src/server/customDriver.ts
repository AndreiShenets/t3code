import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as PullRequests from "./AzureDevOpsServerPullRequestProvider.ts";
import * as SourceControl from "./AzureDevOpsServerSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("azure-devops-custom-server"),
  make: Effect.all({
    sourceControl: SourceControl.make,
    discovery: SourceControl.makeDiscovery,
    pullRequests: PullRequests.make,
  }),
});
