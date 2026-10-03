import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { Minimatch } from "minimatch";

export const DEFAULT_TAB_WIDTH = 2;

interface EditorConfigSection {
  readonly matcher: { match(relativePath: string): boolean };
  readonly properties: Record<string, string>;
}

/** Decimal blocks keep numeric ranges proportional to their digit count, not their size. */
function unsignedRangeSource(min: bigint, max: bigint, padding: number) {
  const blocks: string[] = [];
  while (min <= max) {
    if (min === 0n) {
      blocks.push("0".padStart(padding, "0"));
      min = 1n;
      continue;
    }
    let scale = 1n;
    let digits = 0;
    while (min % (scale * 10n) === 0n && min + scale * 10n - 1n <= max) {
      scale *= 10n;
      digits++;
    }
    const prefix = String(min / scale).padStart(Math.max(0, padding - digits), "0");
    blocks.push(`${prefix}${digits === 0 ? "" : `[0-9]{${digits}}`}`);
    min += scale;
  }
  return `(?:${blocks.join("|")})`;
}

function numericRangeSource(min: bigint, max: bigint, padding: number) {
  const negative =
    min < 0n ? `-${unsignedRangeSource(max < 0n ? -max : 1n, -min, Math.max(0, padding - 1))}` : "";
  const positive = max >= 0n ? unsignedRangeSource(min > 0n ? min : 0n, max, padding) : "";
  return `(?:${[negative, positive].filter(Boolean).join("|")})`;
}

function sectionMatcher(pattern: string) {
  // Minimatch splits at every slash and eagerly expands numeric braces. Protect those
  // EditorConfig tokens before compilation, then insert their compact regex sources.
  let tokenPrefix = "EDITORCONFIGTOKEN";
  while (pattern.includes(tokenPrefix)) tokenPrefix += "X";
  const sources = new Map<string, string>();
  const protect = (source: string) => {
    const token = `${tokenPrefix}${sources.size}END`;
    sources.set(token, source);
    return token;
  };
  let directoryRelative = false;
  const glob = pattern.replace(
    /\\.|\[(?:\\.|[^\]\\])+\]|\{(-?\d+)\.\.(-?\d+)\}|\*\*|\//g,
    (token: string, lower: string | undefined, upper: string | undefined) => {
      if (token.startsWith("[")) {
        if (!token.includes("/")) return token;
        const source = token
          .replace(/^\[!/, "[^")
          .replace(/\\(.)/g, (_escape, character: string) =>
            "\\]^-[".includes(character) ? `\\${character}` : character,
          );
        // Validate ranges before inserting a character class into the compiled regex.
        try {
          return protect(new RegExp(source).source);
        } catch {
          return token;
        }
      }
      if (lower !== undefined && upper !== undefined) {
        const min = BigInt(lower);
        const max = BigInt(upper);
        const padding =
          /^-?0\d/.test(lower) || /^-?0\d/.test(upper) ? Math.max(lower.length, upper.length) : 0;
        return min < max ? protect(numericRangeSource(min, max, padding)) : token;
      }
      if (token.includes("/")) directoryRelative = true;
      // EditorConfig's ** crosses separators even within a path segment.
      return token === "**" ? "{*,**/**/**}" : token;
    },
  );
  const matcher = new Minimatch(glob.replace(/^\//, ""), {
    dot: true,
    matchBase: !directoryRelative,
    nonegate: true,
    nocomment: true,
    noext: true,
    platform: "linux",
    braceExpandMax: 1024,
  });
  if (sources.size === 0) return matcher;
  const compiled = matcher.makeRe();
  const expression = compiled
    ? new RegExp(
        compiled.source.replace(
          new RegExp(`${tokenPrefix}\\d+END`, "g"),
          (token) => sources.get(token) ?? token,
        ),
      )
    : undefined;
  return {
    match(relativePath: string) {
      const path = directoryRelative
        ? relativePath
        : relativePath.slice(relativePath.lastIndexOf("/") + 1);
      return expression?.test(path) ?? false;
    },
  };
}

/** Only indentation display properties are consumed; no editing policy is applied. */
export function parseEditorConfig(contents: string) {
  const sections: EditorConfigSection[] = [];
  let section: EditorConfigSection | undefined;
  let root = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const pattern = line.slice(1, -1);
      section = {
        matcher: sectionMatcher(pattern),
        properties: {},
      };
      sections.push(section);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (section === undefined) {
      if (key === "root") root = value === "true";
    } else if (key === "tab_width" || key === "indent_size") {
      section.properties[key] = value;
    }
  }
  return { root, sections };
}

export type ParsedEditorConfig = ReturnType<typeof parseEditorConfig>;

// Repository roots from Git may use forward-slash UNC paths.
function isWindowsConfigPath(path: string): boolean {
  return isWindowsAbsolutePath(path) || /^\/\/[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(path);
}

/** Workspace files share the relative query key refreshed by the file editor's save flow. */
export function editorConfigQueryPath(cwd: string, configPath: string): string {
  const windows = isWindowsConfigPath(cwd);
  const directory = (windows ? cwd.replaceAll("\\", "/") : cwd).replace(/\/+$/, "");
  const prefix = `${directory}/`;
  const withinWorkspace = windows
    ? configPath.toLowerCase().startsWith(prefix.toLowerCase())
    : configPath.startsWith(prefix);
  return withinWorkspace ? configPath.slice(prefix.length) : configPath;
}

/** Nearest directory first, including ancestors outside the workspace until the filesystem root. */
export function editorConfigCandidates(cwd: string, filePath: string) {
  const windows = isWindowsConfigPath(filePath) || isWindowsConfigPath(cwd);
  const normalize = (path: string) => (windows ? path.replaceAll("\\", "/") : path);
  const file = normalize(filePath);
  const absolute =
    file.startsWith("/") || /^[a-z]:\//i.test(file)
      ? file
      : `${normalize(cwd).replace(/\/$/, "")}/${file}`;
  const root =
    absolute.match(/^[a-z]:\//i)?.[0] ??
    (windows && absolute.startsWith("//") ? absolute.match(/^\/\/[^/]+\/[^/]+\//)?.[0] : "/");
  if (root === undefined) return [];
  const segments: string[] = [];
  for (const segment of absolute.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const filename = segments.pop();
  if (!filename) return [];
  let relativePath = filename;
  const candidates: { configPath: string; relativePath: string }[] = [];
  while (true) {
    const directory = segments.length === 0 ? root : `${root}${segments.join("/")}/`;
    candidates.push({ configPath: `${directory}.editorconfig`, relativePath });
    const parent = segments.pop();
    if (parent === undefined) break;
    relativePath = `${parent}/${relativePath}`;
  }
  return candidates;
}

/** Merge matching pairs from farthest to nearest, then resolve tab_width before indent_size. */
export function resolveEditorConfigTabWidth(
  configs: ReadonlyArray<{ config: ParsedEditorConfig; relativePath: string }>,
): number {
  const properties: Record<string, string> = {};
  for (const { config, relativePath } of configs.toReversed()) {
    for (const section of config.sections) {
      if (!section.matcher.match(relativePath)) continue;
      for (const [key, value] of Object.entries(section.properties)) {
        if (value === "unset") delete properties[key];
        else properties[key] = value;
      }
    }
  }
  for (const value of [properties.tab_width, properties.indent_size]) {
    if (value === undefined || !/^\d+$/.test(value)) continue;
    const width = Number(value);
    if (Number.isSafeInteger(width) && width > 0) return width;
  }
  return DEFAULT_TAB_WIDTH;
}
