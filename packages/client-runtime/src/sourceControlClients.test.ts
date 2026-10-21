import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("sourceControlClients", () => {
  it("distinguishes Azure Server collections from cloud Azure pull request URLs", () => {
    const kindOf = (url: string) => sourceControlClients.findByChangeRequestUrl(url)?.kind;
    expect(kindOf("http://code.example:8080/tfs/collection/project/_git/repo/pullrequest/7")).toBe(
      "azure-devops-custom-server",
    );
    expect(kindOf("https://dev.azure.com/org/project/_git/repo/pullrequest/7")).toBe(
      "azure-devops",
    );
    expect(kindOf("https://org.visualstudio.com/project/_git/repo/pullrequest/7")).toBe(
      "azure-devops",
    );
  });
});
