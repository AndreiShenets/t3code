import { ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

describe("pullRequestSyncKey", () => {
  it("expands custom Azure repository names without dropping collection paths or ports", () => {
    const identity = {
      provider: SourceControlProviderKind.make("azure-devops-custom-server"),
      name: "Web",
      canonicalKey: "code.example:8080/tfs/default%20collection/project/_git/web",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "http://code.example:8080/tfs/Default%20Collection/Project/_git/Web",
      },
    };
    const reference = { projectId: ProjectId.make("project"), repository: "Web", number: 7 };
    const expected = {
      host: "code.example:8080",
      repository: "tfs/default%20collection/project/_git/web",
      number: 7,
    };
    expect(pullRequestSyncKey(reference, identity)).toEqual(expected);
    expect(pullRequestSyncKey({ ...reference, host: "code.example:8080" }, identity)).toEqual(
      expected,
    );
    expect(pullRequestSyncKey({ ...reference, host: "code.example:8081" }, identity)).toBeNull();
    expect(pullRequestSyncKey({ ...reference, repository: "other" }, identity)).toBeNull();
  });
  const reference = { projectId: ProjectId.make("project"), repository: "web", number: 7 };
  // Every spelling of the key reaches dev.azure.com through the definition's canonical key,
  // which the Azure DevOps package tests.
  it("resolves hostless and checkout-host references named by the bare repository", () => {
    const canonicalKey = "ssh.dev.azure.com/v3/org/project/web";
    const identity = {
      canonicalKey,
      provider: SourceControlProviderKind.make("azure-devops"),
      name: "web",
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://${canonicalKey}`,
      },
    };
    const expected = { host: "dev.azure.com", repository: "org/project/_git/web", number: 7 };
    expect(pullRequestSyncKey(reference, identity)).toEqual(expected);
    expect(
      pullRequestSyncKey({ ...reference, host: canonicalKey.split("/")[0]! }, identity),
    ).toEqual(expected);
    expect(pullRequestSyncKey({ ...reference, repository: "other" }, identity)).toBeNull();
    expect(pullRequestSyncKey({ ...reference, host: "unrelated.test" }, identity)).toBeNull();
  });
  it("normalizes complete hosted aliases without requiring a checkout", () => {
    expect(
      pullRequestSyncKey({
        ...reference,
        host: "org.visualstudio.com",
        repository: "project/_git/web",
      }),
    ).toEqual({ host: "dev.azure.com", repository: "org/project/_git/web", number: 7 });
    expect(
      pullRequestSyncKey({ ...reference, host: "github.com", repository: "acme/web" }),
    ).toEqual({ host: "github.com", repository: "acme/web", number: 7 });
    expect(pullRequestSyncKey(reference)).toBeNull();
  });
});
