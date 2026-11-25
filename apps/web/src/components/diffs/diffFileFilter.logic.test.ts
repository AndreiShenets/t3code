import { describe, expect, it } from "vite-plus/test";
import { createDiffFileMatcher, DEFAULT_DIFF_FILE_FILTER } from "./diffFileFilter.logic";

describe("diff file filtering", () => {
  it.each([
    ["", {}, ["src/App.ts", "tests/App.test.ts", "docs/readme.md"]],
    ["APP", {}, ["src/App.ts", "tests/App.test.ts"]],
    ["src/", {}, ["src/App.ts"]],
    ["app", { caseSensitive: true }, []],
    ["App", { caseSensitive: true }, ["src/App.ts", "tests/App.test.ts"]],
    ["App.ts", {}, ["src/App.ts"]],
    ["App", { wholeWord: true }, ["src/App.ts", "tests/App.test.ts"]],
    ["Ap", { wholeWord: true }, []],
    ["^src/.*\\.ts$", { regex: true }, ["src/App.ts"]],
    ["APP\\.TS$", { regex: true, caseSensitive: true }, []],
  ])("filters paths with %j and %j", (query, options, expected) => {
    const matcher = createDiffFileMatcher({ ...DEFAULT_DIFF_FILE_FILTER, query, ...options });
    expect(["src/App.ts", "tests/App.test.ts", "docs/readme.md"].filter(matcher.matches)).toEqual(
      expected,
    );
  });

  it("matches both rename paths, deleted files, and files without hunks", () => {
    const matcher = createDiffFileMatcher({ ...DEFAULT_DIFF_FILE_FILTER, query: "old" });
    expect(matcher.matchesFile({ name: "src/new.ts", prevName: "src/old.ts" })).toBe(true);
    expect(matcher.matchesFile({ name: "old/deleted.bin" })).toBe(true);
    expect(matcher.matchesFile({ name: "src/new.ts" })).toBe(false);
  });

  it("reports invalid regexes without hiding every file", () => {
    const matcher = createDiffFileMatcher({
      ...DEFAULT_DIFF_FILE_FILTER,
      query: "[",
      regex: true,
    });
    expect(matcher.error).not.toBeNull();
    expect(matcher.matches("anything.ts")).toBe(true);
    expect(matcher.matchesFile({ name: "anything.ts" })).toBe(true);
  });

  it("keeps repeated regex matches stateless and literal regex punctuation literal", () => {
    const matcher = createDiffFileMatcher({
      ...DEFAULT_DIFF_FILE_FILTER,
      query: "src/",
      regex: true,
    });
    expect(["src/a.ts", "src/b.ts", "src/c.ts"].every(matcher.matches)).toBe(true);
    expect(
      createDiffFileMatcher({ ...DEFAULT_DIFF_FILE_FILTER, query: "a[1].ts" }).matches("a[1].ts"),
    ).toBe(true);
    expect(
      createDiffFileMatcher({ ...DEFAULT_DIFF_FILE_FILTER, query: "a.ts" }).matches("aXts"),
    ).toBe(false);
  });
});
