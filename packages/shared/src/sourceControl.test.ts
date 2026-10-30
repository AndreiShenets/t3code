import { describe, expect, it } from "vite-plus/test";

import { getPullRequestActorName } from "./sourceControl.ts";

describe("getPullRequestActorName", () => {
  it("shows a known name instead of an opaque account ID", () => {
    expect(
      getPullRequestActorName({
        login: "64d61648-5e0b-4335-bcec-3a3d88963c89",
        name: "Andrei Shenets",
      }),
    ).toBe("Andrei Shenets");
  });

  it("falls back to the login when the name is missing or blank", () => {
    for (const name of [null, "", "   "]) {
      expect(getPullRequestActorName({ login: "octocat", name })).toBe("octocat");
    }
  });

  it("trims display names and preserves readable handles", () => {
    expect(getPullRequestActorName({ login: "octocat", name: "  Mona Lisa  " })).toBe("Mona Lisa");
    expect(getPullRequestActorName({ login: "octocat", name: "octocat" })).toBe("octocat");
  });

  it("preserves the caller's missing-author label", () => {
    expect(getPullRequestActorName(null)).toBe("ghost");
    expect(getPullRequestActorName(undefined, "Unknown author")).toBe("Unknown author");
  });
});
