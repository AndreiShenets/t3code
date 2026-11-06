import { describe, expect, it } from "vite-plus/test";

import {
  editorConfigCandidates,
  parseEditorConfig,
  resolveEditorConfigTabSize,
} from "./editorConfig";

function tabSize(contents: string, relativeFilePath = "src/app.ts") {
  return resolveEditorConfigTabSize([{ config: parseEditorConfig(contents), relativeFilePath }]);
}

describe("EditorConfig display tab width", () => {
  it("prefers tab_width, falls back to numeric indent_size, and otherwise keeps two columns", () => {
    expect(tabSize("[*]\nindent_size = 4\ntab_width = 8")).toBe(8);
    expect(tabSize("[*]\nindent_size = 4")).toBe(4);
    expect(tabSize("[*]\nindent_size = tab\ntab_width = 3")).toBe(3);
    expect(tabSize("[*]\nindent_style = tab\nindent_size = tab")).toBe(2);
    expect(tabSize("")).toBe(2);
  });

  it("merges matching sections per property, in order", () => {
    const contents =
      "root = true\n[*]\nindent_size = 4\ntab_width = 4\n[*.md]\nindent_size = 2\n[docs/*.md]\ntab_width = 6";
    expect(tabSize(contents)).toBe(4);
    expect(tabSize(contents, "README.md")).toBe(4);
    expect(tabSize(contents, "docs/README.md")).toBe(6);
    expect(tabSize(contents, "docs/nested/README.md")).toBe(4);
  });

  it("inherits ancestor properties and honors a nearer root boundary even without a matching section", () => {
    const configs = [
      { config: parseEditorConfig("[*.ts]\nindent_size = 3"), relativeFilePath: "app.ts" },
      {
        config: parseEditorConfig("root = true\n[*]\ntab_width = 8"),
        relativeFilePath: "src/app.ts",
      },
      { config: parseEditorConfig("[*]\ntab_width = 12"), relativeFilePath: "repo/src/app.ts" },
    ];
    expect(resolveEditorConfigTabSize(configs)).toBe(8);
    configs[0]!.config = parseEditorConfig("root = true\n[*.md]\ntab_width = 4");
    expect(resolveEditorConfigTabSize(configs)).toBe(2);
  });

  it("unsets inherited values without changing unrelated properties", () => {
    expect(
      resolveEditorConfigTabSize([
        { config: parseEditorConfig("[*]\ntab_width = unset"), relativeFilePath: "app.ts" },
        {
          config: parseEditorConfig("[*]\ntab_width = 8\nindent_size = 4"),
          relativeFilePath: "src/app.ts",
        },
      ]),
    ).toBe(4);
    expect(
      tabSize(
        "[*]\ntab_width = 8\nindent_size = 4\n[*.ts]\ntab_width = unset\nindent_size = unset",
      ),
    ).toBe(2);
  });

  it.each(["0", "-4", "2.5", "Infinity", "NaN", "four", "4px", "4 # comment", "9007199254740992"])(
    "ignores unsupported width %s",
    (width) => {
      expect(tabSize(`[*]\ntab_width = ${width}`)).toBe(2);
      expect(tabSize(`[*]\ntab_width = ${width}\nindent_size = 4`)).toBe(4);
    },
  );

  it("accepts CRLF, BOM, case-insensitive properties, and full-line comments", () => {
    expect(
      tabSize(
        "\uFEFFROOT = TRUE\r\n# comment\r\n; comment\r\n[*]\r\nTAB_WIDTH = 4\r\nIndent_Size = TAB",
      ),
    ).toBe(4);
    expect(tabSize("tab_width = 8\n[*.md]\ntab_width = 4")).toBe(2);
  });

  it.each([
    ["*.{ts,tsx}", "src/app.tsx"],
    ["src/file{1..3}.ts", "src/file2.ts"],
    ["src/[ab].ts", "src/a.ts"],
    ["src/[!a].ts", "src/b.ts"],
    ["src/?.ts", "src/a.ts"],
    ["/src/*.ts", "src/app.ts"],
    ["src/**.ts", "src/deep/app.ts"],
    ["**/nested/*.ts", "nested/app.ts"],
    ["**/nested/*.ts", "src/nested/app.ts"],
    ["*", ".hidden/app.ts"],
    ["!special.ts", "src/!special.ts"],
    ["#special.ts", "src/#special.ts"],
    ["literal\\[name\\].ts", "literal[name].ts"],
  ])("matches %s against %s", (pattern, file) => {
    expect(tabSize(`[${pattern}]\ntab_width = 5`, file)).toBe(5);
  });

  it("keeps patterns case-sensitive and preserves spaces in section names", () => {
    expect(tabSize("[*.TS]\ntab_width = 4")).toBe(2);
    expect(tabSize("[a b.ts]\ntab_width = 6", "a b.ts")).toBe(6);
  });

  it.each([
    ["[a/]foo.ts", "nested/afoo.ts", true],
    ["[a/]foo.ts", "afoo.ts", true],
    ["[a/]foo.ts", "nested/bfoo.ts", false],
    ["dir/[a/]foo.ts", "nested/dir/afoo.ts", false],
    ["a[/]b.ts", "nested/a/b.ts", true],
    ["a[!b]c.ts", "nested/a/c.ts", true],
    ["a[!b/]c.ts", "nested/a/c.ts", false],
    ["[0-9].ts", "src/0.ts", true],
    ["[0-9].ts", "src/-.ts", true],
    ["[0-9].ts", "src/9.ts", true],
    ["[0-9].ts", "src/5.ts", false],
    ["[!0-9].ts", "src/5.ts", true],
    ["[!0-9].ts", "src/-.ts", false],
    ["[^a].ts", "src/^.ts", true],
    ["[^a].ts", "src/b.ts", false],
    ["[ab*c{1..2}].ts", "src/{.ts", true],
    ["[ab*c{1..2}].ts", "src/3.ts", false],
    ["[**].ts", "src/*.ts", true],
    ["[**].ts", "src/app.ts", false],
    [String.raw`[\]a].ts`, "src/].ts", true],
  ])("uses EditorConfig character classes: %s against %s (%s)", (pattern, file, matches) => {
    expect(tabSize(`[${pattern}]\ntab_width = 5`, file)).toBe(matches ? 5 : 2);
  });

  it.each([
    ["a**z.ts", "other/abc/nested/z.ts", true],
    ["a**z.ts", "other/xabc/nested/z.ts", false],
    ["a**z.ts", "other/az.ts", true],
    [String.raw`a\**z.ts`, "other/a*middlez.ts", true],
    [String.raw`a\**z.ts`, "other/abc/nested/z.ts", false],
    [String.raw`a\*\*z.ts`, "other/a**z.ts", true],
    [String.raw`a\*\*z.ts`, "other/abcz.ts", false],
    [String.raw`a\***z.ts`, "other/a*bc/nested/z.ts", true],
    ["a(b|c).ts", "src/a(b|c).ts", true],
    ["a(b|c).ts", "src/ab.ts", false],
    ["{a..b,x}.ts", "src/a..b.ts", true],
    ["{a..b,x}.ts", "src/x.ts", true],
    ["{a..b}.ts", "src/{a..b}.ts", true],
    ["{a..b}.ts", "src/a.ts", false],
  ])("preserves glob boundaries and literals: %s against %s (%s)", (pattern, file, matches) => {
    expect(tabSize(`[${pattern}]\ntab_width = 5`, file)).toBe(matches ? 5 : 2);
  });

  it("matches million-value ranges at every directory level without expansion", () => {
    const config = parseEditorConfig("[file{1..1000000}.ts]\ntab_width = 5");
    for (const prefix of ["", "src/", "src/nested/"]) {
      for (const value of [0, 1, 5000, 999999, 1000000, 1000001]) {
        expect(
          resolveEditorConfigTabSize([{ config, relativeFilePath: `${prefix}file${value}.ts` }]),
        ).toBe(value >= 1 && value <= 1000000 ? 5 : 2);
      }
    }
    expect(config.sections[0]!.matcher.source.length).toBeLessThan(1000);
  });

  it.each(["{1..1000000}".repeat(16), "{1..1000000}*".repeat(16), "{{1..9},}".repeat(16)])(
    "rejects ambiguous numeric combinations before matching: %s",
    (pattern) => {
      const config = parseEditorConfig(`[${pattern}.ts]\ntab_width = 5`);
      // Assert rejection first: a regression must fail here rather than execute a hanging regex.
      expect(config.sections).toHaveLength(0);
      expect(
        resolveEditorConfigTabSize([
          { config, relativeFilePath: "1".repeat(60) + ".tx" },
          { config: parseEditorConfig("[*]\ntab_width = 3"), relativeFilePath: "file.tx" },
        ]),
      ).toBe(3);
    },
  );

  it("bounds input-dependent wildcard placements without rejecting ordinary numeric globs", () => {
    const config = parseEditorConfig(`[${"{1..9}*".repeat(16)}.ts]\ntab_width = 5`);
    expect(resolveEditorConfigTabSize([{ config, relativeFilePath: "1".repeat(60) + ".tx" }])).toBe(
      2,
    );
    expect(tabSize("[src/**/file{1..3}.*]\ntab_width = 5", "src/nested/file2.ts")).toBe(5);
    expect(tabSize("[{1..20}*{1..20}*]\ntab_width = 5", "12-middle-20.ts")).toBe(5);
  });

  it("bounds the product of numeric widths and alternative choices across the entire section", () => {
    for (const range of ["{1..20}", "{-9..9}", "{{1..9},}"]) {
      const accepted = parseEditorConfig(`[${range.repeat(10)}.ts]\ntab_width = 5`);
      expect(accepted.sections).toHaveLength(1);
      expect(
        resolveEditorConfigTabSize([
          { config: accepted, relativeFilePath: "1".repeat(10) + ".ts" },
        ]),
      ).toBe(5);
      expect(parseEditorConfig(`[${range.repeat(11)}.ts]\ntab_width = 5`).sections).toHaveLength(0);
    }
    expect(tabSize(`[${"{1..9}".repeat(16)}.ts]\ntab_width = 5`, "1".repeat(16) + ".ts")).toBe(5);
    expect(tabSize("[{1..20}*{1..20}.ts]\ntab_width = 5", "12-middle-20.ts")).toBe(5);
    expect(tabSize(String.raw`[a\*{1..20}*{1..20}.ts]` + "\ntab_width = 5", "a*12-x-20.ts")).toBe(
      5,
    );
  });

  it.each([
    [-120, -100],
    [-12, -1],
    [-12, 12],
    [0, 100],
    [8, 123],
    [100, 203],
  ])("matches exactly the signed integer interval %i..%i", (lower, upper) => {
    const config = parseEditorConfig(`[file{${lower}..${upper}}.ts]\ntab_width = 5`);
    for (let value = -130; value <= 220; value++) {
      expect(resolveEditorConfigTabSize([{ config, relativeFilePath: `file${value}.ts` }])).toBe(
        value >= lower && value <= upper ? 5 : 2,
      );
    }
  });

  it.each([
    ["file{9007199254740992..9007199254740994}.ts", "file9007199254740993.ts", true],
    ["file{9007199254740992..9007199254740994}.ts", "file9007199254740991.ts", false],
    ["file{9007199254740992..9007199254740994}.ts", "file9007199254740995.ts", false],
    ["file{-9007199254740994..-9007199254740992}.ts", "file-9007199254740993.ts", true],
    ["file{001..003}.ts", "file2.ts", true],
    ["file{001..003}.ts", "file002.ts", false],
    ["file{-02..+02}.ts", "file-2.ts", true],
    ["file{-02..+02}.ts", "file0.ts", true],
    ["file{-02..+02}.ts", "file2.ts", true],
    ["file{-02..+02}.ts", "file+2.ts", false],
    ["file{-02..+02}.ts", "file-02.ts", false],
    ["file{-02..+02}.ts", "file-0.ts", false],
    ["file{1..20}{1..20}.ts", "file120.ts", true],
    ["file{1..20}{1..20}.ts", "file100.ts", false],
    ["{file{1..1000000},other}.ts", "file999999.ts", true],
    ["{file{1..1000000},other}.ts", "other.ts", true],
    ["file{3..1}.ts", "file2.ts", false],
    ["file{3..1}.ts", "file{3..1}.ts", true],
    ["file{1..1}.ts", "file1.ts", false],
  ])("matches numeric ranges exactly: %s against %s (%s)", (pattern, file, matches) => {
    expect(tabSize(`[${pattern}]\ntab_width = 5`, file)).toBe(matches ? 5 : 2);
  });

  it("accepts 1024-character sections and bounds conversion work before compiling oversized sections", () => {
    const literal = "a".repeat(1021) + ".ts";
    expect(tabSize(`[${literal}]\ntab_width = 5`, literal)).toBe(5);
    expect(tabSize(`[a${literal}]\ntab_width = 5`, `a${literal}`)).toBe(2);

    // Arbitrary-precision bounds stay compact even at the section-length limit.
    const bound = "9".repeat(1012);
    expect(tabSize(`[file{1..${bound}}.ts]\ntab_width = 5`, "file999999.ts")).toBe(5);
    expect(tabSize(`[file{1..${bound}}.ts]\ntab_width = 5`, `file${bound}.ts`)).toBe(5);
    const oversized = "9".repeat(1024 * 1024);
    expect(
      tabSize(`[*]\ntab_width = 3\n[file{1..${oversized}}.ts]\ntab_width = 5`, "file999999.ts"),
    ).toBe(3);
  });

  it("bounds regex compilation work for complex intervals even within the section-length limit", () => {
    const bound = "1234567890".repeat(101) + "12";
    const config = parseEditorConfig(`[*]\ntab_width = 3\n[file{1..${bound}}.ts]\ntab_width = 5`);
    expect(resolveEditorConfigTabSize([{ config, relativeFilePath: `file${bound}.ts` }])).toBe(3);
  });

  it("preserves every digit of longer signed decimal bounds within the compilation budget", () => {
    const lower = 1234567890123456789012345678901234567890123456789012345678901234n;
    const upper = 2345678901234567890123456789012345678901234567890123456789012345n;
    for (const sign of [1n, -1n]) {
      const first = sign > 0n ? lower : -upper;
      const last = sign > 0n ? upper : -lower;
      const config = parseEditorConfig(`[file{${first}..${last}}.ts]\ntab_width = 5`);
      for (const value of [first - 1n, first, first + 1n, last - 1n, last, last + 1n]) {
        expect(resolveEditorConfigTabSize([{ config, relativeFilePath: `file${value}.ts` }])).toBe(
          value >= first && value <= last ? 5 : 2,
        );
      }
    }
  });
});

describe("EditorConfig ancestor paths", () => {
  it("walks POSIX ancestors, including those above the workspace", () => {
    expect(editorConfigCandidates("/repo", "src/app.ts")).toEqual([
      { path: "/repo/src/.editorconfig", relativeFilePath: "app.ts" },
      { path: "/repo/.editorconfig", relativeFilePath: "src/app.ts" },
      { path: "/.editorconfig", relativeFilePath: "repo/src/app.ts" },
    ]);
  });

  it("walks Windows drive and UNC paths without consulting the browser's platform", () => {
    expect(editorConfigCandidates("C:\\repo", "src/app.ts")).toEqual([
      { path: "C:/repo/src/.editorconfig", relativeFilePath: "app.ts" },
      { path: "C:/repo/.editorconfig", relativeFilePath: "src/app.ts" },
      { path: "C:/.editorconfig", relativeFilePath: "repo/src/app.ts" },
    ]);
    expect(editorConfigCandidates("\\\\server\\share\\repo", "app.ts")).toEqual([
      { path: "//server/share/repo/.editorconfig", relativeFilePath: "app.ts" },
      { path: "//server/share/.editorconfig", relativeFilePath: "repo/app.ts" },
    ]);
  });

  it("uses the actual host file location when it is outside the checkout", () => {
    expect(editorConfigCandidates("/repo", "/elsewhere/app.ts")[0]).toEqual({
      path: "/elsewhere/.editorconfig",
      relativeFilePath: "app.ts",
    });
  });

  it("normalizes dot segments before deciding which directories apply", () => {
    expect(editorConfigCandidates("/repo", "src/../app.ts")).toEqual([
      { path: "/repo/.editorconfig", relativeFilePath: "app.ts" },
      { path: "/.editorconfig", relativeFilePath: "repo/app.ts" },
    ]);
    expect(editorConfigCandidates("C:\\repo", ".\\src\\..\\app.ts")[0]).toEqual({
      path: "C:/repo/.editorconfig",
      relativeFilePath: "app.ts",
    });
  });
});
