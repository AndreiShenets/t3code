import { describe, expect, it } from "vite-plus/test";

import {
  editorConfigCandidates,
  editorConfigQueryPath,
  parseEditorConfig,
  resolveEditorConfigTabWidth,
} from "./editorConfig";

function width(contents: string, relativePath = "src/index.ts") {
  return resolveEditorConfigTabWidth([{ config: parseEditorConfig(contents), relativePath }]);
}

describe("EditorConfig tab width", () => {
  it("uses tab_width before indent_size and otherwise preserves the two-column default", () => {
    expect(width("[*]\nindent_size = 4\ntab_width = 8")).toBe(8);
    expect(width("[*]\nindent_size = 4")).toBe(4);
    expect(width("[*]\nindent_size = tab")).toBe(2);
    expect(width("[*]\nindent_style = tab")).toBe(2);
    expect(width("# No settings")).toBe(2);
  });

  it("applies matching sections in order, inheriting properties rather than whole sections", () => {
    const config = "root = true\n[*]\nindent_size = 4\ntab_width = 4\n[*.md]\nindent_size = 2";
    expect(width(config)).toBe(4);
    // indent_size does not clear a tab_width inherited from an earlier matching section.
    expect(width(config, "docs/guide.md")).toBe(4);
    expect(width(`${config}\ntab_width = unset`, "docs/guide.md")).toBe(2);
  });

  it("merges parent configurations before nearer ones and supports unset", () => {
    const parent = {
      config: parseEditorConfig("[*]\nindent_size = 4\ntab_width = 8"),
      relativePath: "src/a.ts",
    };
    const child = {
      config: parseEditorConfig("[*.ts]\ntab_width = unset\nindent_size = 6"),
      relativePath: "a.ts",
    };
    expect(resolveEditorConfigTabWidth([child, parent])).toBe(6);
    expect(
      resolveEditorConfigTabWidth([
        { ...child, config: parseEditorConfig("[*.ts]\nindent_size = 3") },
        parent,
      ]),
    ).toBe(8);
  });

  it.each(["0", "-1", "1.5", "4px", "NaN", "4 # comment", "9007199254740992"])(
    "ignores unsupported tab_width %s",
    (value) => {
      expect(width(`[*]\ntab_width = ${value}\nindent_size = 3`)).toBe(3);
    },
  );

  it("handles CRLF, BOM, case-insensitive pairs and preamble-only root", () => {
    const config = parseEditorConfig(
      "\uFEFFROOT = TRUE\r\n; comment\r\n[*]\r\nTAB_WIDTH = 4\r\nroot = false",
    );
    expect(config.root).toBe(true);
    expect(resolveEditorConfigTabWidth([{ config, relativePath: ".hidden" }])).toBe(4);
    expect(parseEditorConfig("[*]\nroot = true").root).toBe(false);
  });

  it.each([
    ["*.ts", "nested/file.ts", true],
    ["/file.ts", "nested/file.ts", false],
    ["/file.ts", "file.ts", true],
    ["src/*.ts", "src/nested/file.ts", false],
    ["src/**/*.ts", "src/nested/file.ts", true],
    ["src/a**z.ts", "src/abc/nested/z.ts", true],
    ["src/a**z.ts", "src/az.ts", true],
    ["*.{ts,tsx}", "src/view.tsx", true],
    ["file{1..3}.ts", "file2.ts", true],
    ["file{1..3}.ts", "file4.ts", false],
    ["[!a].ts", "b.ts", true],
    ["*.ts", ".hidden.ts", true],
    ["!special.ts", "!special.ts", true],
    ["file\\?.ts", "file?.ts", true],
  ])("matches [%s] against %s: %s", (pattern, path, matches) => {
    expect(width(`[${pattern}]\ntab_width = 4`, path)).toBe(matches ? 4 : 2);
  });
});

describe("EditorConfig lookup paths", () => {
  it.each([
    ["/repo", "/repo/.editorconfig", ".editorconfig"],
    ["/repo/", "/repo/src/.editorconfig", "src/.editorconfig"],
    ["/repo", "/.editorconfig", "/.editorconfig"],
    ["/repo", "/repo-other/.editorconfig", "/repo-other/.editorconfig"],
    ["/", "/.editorconfig", ".editorconfig"],
    ["C:\\repo", "C:/repo/src/.editorconfig", "src/.editorconfig"],
    ["C:\\REPO\\", "c:/repo/.editorconfig", ".editorconfig"],
    ["C:\\repo", "C:/.editorconfig", "C:/.editorconfig"],
    ["\\\\host\\share\\repo", "//host/share/repo/.editorconfig", ".editorconfig"],
    ["\\\\host\\share\\repo", "//host/share/.editorconfig", "//host/share/.editorconfig"],
    ["//HOST/share/REPO", "//host/share/repo/src/.editorconfig", "src/.editorconfig"],
    ["//host/share/repo", "//host/share/.editorconfig", "//host/share/.editorconfig"],
    ["//host/share", "//host/share/.editorconfig", ".editorconfig"],
  ])("shares the save query key for %s and %s", (cwd, configPath, expected) => {
    expect(editorConfigQueryPath(cwd, configPath)).toBe(expected);
  });

  it("searches from the file directory through parents above the workspace", () => {
    expect(editorConfigCandidates("/repo", "src/file.ts")).toEqual([
      { configPath: "/repo/src/.editorconfig", relativePath: "file.ts" },
      { configPath: "/repo/.editorconfig", relativePath: "src/file.ts" },
      { configPath: "/.editorconfig", relativePath: "repo/src/file.ts" },
    ]);
  });

  it("normalizes Windows separators and stops at the drive or UNC share root", () => {
    expect(
      editorConfigCandidates("C:\\repo", "src\\file.ts").map((candidate) => candidate.configPath),
    ).toEqual(["C:/repo/src/.editorconfig", "C:/repo/.editorconfig", "C:/.editorconfig"]);
    expect(
      editorConfigCandidates("\\\\host\\share\\repo", "file.ts").map(
        (candidate) => candidate.configPath,
      ),
    ).toEqual(["//host/share/repo/.editorconfig", "//host/share/.editorconfig"]);
  });

  it("resolves absolute host files and normalizes dot segments without changing Unix backslashes", () => {
    expect(editorConfigCandidates("/repo", "/tmp/file.ts")[0]).toEqual({
      configPath: "/tmp/.editorconfig",
      relativePath: "file.ts",
    });
    expect(editorConfigCandidates("/repo", "./src/../file.ts")[0]).toEqual({
      configPath: "/repo/.editorconfig",
      relativePath: "file.ts",
    });
    expect(editorConfigCandidates("/repo", "literal\\file.ts")[0]?.relativePath).toBe(
      "literal\\file.ts",
    );
  });

  it.each(["//host/share/repo", "\\\\host\\share\\repo"])(
    "preserves the network share root for %s and absolute Git paths",
    (cwd) => {
      for (const file of ["src/file.ts", "//host/share/repo/src/file.ts"]) {
        expect(editorConfigCandidates(cwd, file)).toEqual([
          { configPath: "//host/share/repo/src/.editorconfig", relativePath: "file.ts" },
          { configPath: "//host/share/repo/.editorconfig", relativePath: "src/file.ts" },
          { configPath: "//host/share/.editorconfig", relativePath: "repo/src/file.ts" },
        ]);
      }
      expect(editorConfigCandidates(cwd, "../../../../file.ts")).toEqual([
        { configPath: "//host/share/.editorconfig", relativePath: "file.ts" },
      ]);
    },
  );
});
