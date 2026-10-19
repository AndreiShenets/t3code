import { describe, expect, it } from "vite-plus/test";
import { secretSettingsFields } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/client/definition";
import { definition, settings } from "./customDefinition.ts";

describe("Azure DevOps Server client", () => {
  const remoteUrl = "http://code.example:8080/tfs/Default%20Collection/My%20Project/_git/Web";
  const identity = {
    canonicalKey: "code.example:8080/tfs/default%20collection/my%20project/_git/web",
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
    name: "Web",
  };

  it("defaults to automatic authentication without sharing cloud settings", () => {
    expect(readSourceControlHostSettings(settings, {})).toEqual({
      collectionUrl: "",
      authentication: "auto",
      personalAccessToken: "",
    });
    expect(definition.label).toBe("JDWeb Server (custom)");
    expect(secretSettingsFields(settings)).toEqual(["personalAccessToken"]);
    expect(definition.checkoutCommand()).toBeNull();
    expect(definition.checkoutCommandArgument()).toBeNull();
  });

  it("recognizes branded servers without claiming cloud URLs or trusting another collection", () => {
    const url = `${remoteUrl}/pullrequest/7`;
    expect(definition.isChangeRequestReference(url)).toBe(true);
    expect(
      definition.isChangeRequestUrl("https://dev.azure.com/org/project/_git/repo/pullrequest/7"),
    ).toBe(false);
    expect(
      definition.isChangeRequestUrl("https://org.visualstudio.com/project/_git/repo/pullrequest/7"),
    ).toBe(false);
    expect(definition.isChangeRequestUrl("https://code.example/project/pullrequest/7")).toBe(false);
    expect(
      definition.isChangeRequestUrl("javascript://code.example/project/_git/repo/pullrequest/7"),
    ).toBe(false);
    const link = parseChangeRequestUrl(url)!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(identity, { ...link, authority: "code.example:8081" }),
    ).toBe(false);
    expect(
      definition.isChangeRequestInRepository(identity, {
        ...link,
        repository: "tfs/other/my%20project/_git/web",
      }),
    ).toBe(false);
    expect(definition.canReadChangeRequestOnHost()).toBe(false);
  });

  it("preserves the configured browser URL and remote HTTP origin", () => {
    const input = {
      host: "code.example:8080",
      repository: "tfs/default%20collection/my%20project/_git/web",
      number: 7,
      remoteUrl,
    };
    expect(definition.changeRequestUrl(input)).toBe(
      "http://code.example:8080/tfs/default%20collection/my%20project/_git/web/pullrequest/7",
    );
    expect(definition.changeRequestUrl({ ...input, webUrl: remoteUrl })).toBe(
      `${remoteUrl}/pullrequest/7`,
    );
  });
});
