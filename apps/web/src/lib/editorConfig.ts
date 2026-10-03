import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { Minimatch } from "minimatch";

export const DEFAULT_TAB_WIDTH = 2;

interface EditorConfigSection {
  readonly matcher: Minimatch;
  readonly properties: Record<string, string>;
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
        // EditorConfig's ** may cross separators even in the middle of a path segment.
        // This is the same expansion used by editorconfig-core-js's buildFullGlob.
        matcher: new Minimatch(pattern.replace(/^\//, "").replace(/\*\*/g, "{*,**/**/**}"), {
          dot: true,
          matchBase: !pattern.includes("/"),
          nonegate: true,
          nocomment: true,
          noext: true,
          platform: "linux",
          braceExpandMax: 1024,
        }),
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
