import { isWindowsAbsolutePath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import picomatch from "picomatch";

export const DEFAULT_CODE_TAB_SIZE = 2;
const MAX_SECTION_LENGTH = 1024;
const MAX_REGEX_LENGTH = 64 * 1024;
const MAX_NUMERIC_MATCH_WORK = 100_000;
const MAX_NUMERIC_MATCH_CHOICES = 1024;

interface EditorConfigSection {
  readonly matcher: Pick<RegExp, "source" | "test">;
  readonly properties: Map<string, string>;
}

export interface EditorConfig {
  readonly root: boolean;
  readonly sections: ReadonlyArray<EditorConfigSection>;
}

/** Only display properties are consumed; indentation and file contents are never changed. */
export function parseEditorConfig(contents: string): EditorConfig {
  let root = false;
  let properties: Map<string, string> | undefined;
  const sections: EditorConfigSection[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      properties = new Map();
      // The spec permits this limit. Check before parsing bounds or compiling globs.
      if (line.length > MAX_SECTION_LENGTH + 2) continue;
      try {
        const matcher = sectionMatcher(line.slice(1, -1));
        if (matcher !== undefined) sections.push({ matcher, properties });
      } catch {
        // An unsupported glob must not prevent the file itself from opening.
      }
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (properties === undefined) {
      if (key === "root") root = value === "true";
    } else if (key === "tab_width" || key === "indent_size") {
      properties.set(key, value);
    }
  }
  return { root, sections };
}

/** Adapt EditorConfig's literal classes and cross-segment ** to Picomatch's dialect. */
function sectionMatcher(pattern: string) {
  let hasSeparator = false;
  let hasNumericRange = false;
  let matchChoices = 1;
  let wildcards = 0;
  let braces = 0;
  // Regex engines may expand quantified branches internally, even when their source is compact.
  const rangeBudget = { remaining: 8192 };
  const glob = pattern.replace(
    /\\[\s\S]|\[((?:\\[\s\S]|[^\\\]])+)\]|\{([+-]?\d+)\.\.([+-]?\d+)\}|\*+|[{},.()|"/\\]/g,
    (
      token: string,
      sequence: string | undefined,
      start: string | undefined,
      end: string | undefined,
      offset: number,
    ) => {
      if (sequence !== undefined) {
        const negative = sequence.startsWith("!");
        const characters = (negative ? sequence.slice(1) : sequence).replace(/\\([\s\S])/g, "$1");
        const escaped = Array.from(characters, (character) =>
          "\\^-[]".includes(character) ? `\\${character}` : character,
        ).join("");
        const bracket = `[${negative ? "^" : ""}${escaped}]`;
        // Picomatch excludes separators from negated classes; EditorConfig doesn't.
        return negative && !characters.includes("/") ? `{${bracket},/}` : bracket;
      }
      if (start !== undefined && end !== undefined) {
        const lower = BigInt(start);
        const upper = BigInt(end);
        if (lower >= upper) return `\\{${start}\\x2e\\x2e${end}\\}`;
        hasNumericRange = true;
        const shortest = lower >= 0n ? String(lower).length : upper < 0n ? String(upper).length : 1;
        const longest = Math.max(String(lower).length, String(upper).length);
        matchChoices = Math.min(
          MAX_NUMERIC_MATCH_CHOICES + 1,
          matchChoices * (longest - shortest + 1),
        );
        return `{${lower}..${upper}}`;
      }
      if (token === "{" || token === "}" || token === ",") {
        if (token === "{") braces++;
        else if (token === "}") braces = Math.max(0, braces - 1);
        else if (braces > 0)
          matchChoices = Math.min(MAX_NUMERIC_MATCH_CHOICES + 1, matchChoices * 2);
        return token;
      }
      if (token.startsWith("*")) {
        wildcards++;
        if (token === "*") return token;
        const previous = pattern[offset - 1];
        const next = pattern[offset + token.length];
        return (previous === undefined || previous === "/") && (next === undefined || next === "/")
          ? "**"
          : "{*,**/**/**}";
      }
      const character = token.startsWith("\\") && token.length > 1 ? token.slice(1) : token;
      if (character === "/") {
        hasSeparator = true;
        return "/";
      }
      // Hex escapes keep literal dots, parentheses and escaped stars out of the glob grammar.
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    },
  );
  // Multiply possible range lengths even across separators or mutually exclusive alternatives.
  if (hasNumericRange && matchChoices > MAX_NUMERIC_MATCH_CHOICES) return undefined;
  const relativeGlob = hasSeparator ? glob.replace(/^\//, "") : `**/${glob}`;
  const options = {
    maxLength: MAX_REGEX_LENGTH,
    dot: true,
    nonegate: true,
    noextglob: true,
    posix: false,
    literalBrackets: false,
    regex: false,
    strictSlashes: true,
    windows: false,
    expandRange: (start: string, end: string) => integerRange(start, end, rangeBudget),
  } satisfies picomatch.PicomatchOptions;
  const parsed = picomatch.parse(relativeGlob, options);
  if (parsed.output.length > MAX_REGEX_LENGTH) return undefined;
  const matcher = new RegExp(`^(?:${parsed.output})(?![\\s\\S])`, "s");
  if (!hasNumericRange) return matcher;
  return {
    source: matcher.source,
    test(path: string) {
      // Star placements depend on the input length. Budget those at match time so
      // ordinary combinations like src/**/file{1..3}.* remain supported.
      let work = matchChoices * (hasSeparator ? 1 : path.split("/").length);
      for (let index = 0; index < wildcards; index++) {
        work *= path.length + 1;
        if (work > MAX_NUMERIC_MATCH_WORK) return false;
      }
      return work <= MAX_NUMERIC_MATCH_WORK && matcher.test(path);
    },
  };
}

/** Bounds normalize signs/padding; filenames use canonical decimals (the core tests reject 060).
 * Compile exact intervals without enumeration. Bounds and regex work are limited above.
 */
function integerRange(start: string, end: string, budget: { remaining: number }) {
  const lower = BigInt(start);
  const upper = BigInt(end);
  const alternatives: string[] = [];
  if (lower < 0n) {
    alternatives.push(
      `-${unsignedRange(String(upper < 0n ? -upper : 1n), String(-lower), budget)}`,
    );
  }
  if (upper >= 0n) {
    alternatives.push(unsignedRange(String(lower > 0n ? lower : 0n), String(upper), budget));
  }
  return `(?:${alternatives.join("|")})`;
}

function unsignedRange(lower: string, upper: string, budget: { remaining: number }): string {
  if (lower.length === upper.length) return fixedWidthRange(lower, upper, budget);
  const alternatives = [fixedWidthRange(lower, "9".repeat(lower.length), budget)];
  if (upper.length > lower.length + 1) {
    budget.remaining -= upper.length;
    alternatives.push(`[1-9][0-9]{${lower.length},${upper.length - 2}}`);
  }
  alternatives.push(fixedWidthRange(`1${"0".repeat(upper.length - 1)}`, upper, budget));
  return `(?:${alternatives.join("|")})`;
}

/** Share decimal prefixes so regex size grows with bound lengths, not interval size. */
function fixedWidthRange(lower: string, upper: string, budget: { remaining: number }): string {
  budget.remaining -= lower.length;
  if (budget.remaining < 0) throw new RangeError("EditorConfig numeric range is too complex");
  if (lower === upper) return lower;
  if (/^0+$/.test(lower) && /^9+$/.test(upper)) return `[0-9]{${lower.length}}`;
  let common = 0;
  while (lower[common] === upper[common]) common++;
  const first = Number(lower[common]);
  const last = Number(upper[common]);
  const remaining = lower.length - common - 1;
  const prefix = lower.slice(0, common);
  if (remaining === 0) return `${prefix}[${first}-${last}]`;
  const alternatives = [
    `${first}${fixedWidthRange(lower.slice(common + 1), "9".repeat(remaining), budget)}`,
  ];
  if (first + 1 < last) alternatives.push(`[${first + 1}-${last - 1}][0-9]{${remaining}}`);
  alternatives.push(
    `${last}${fixedWidthRange("0".repeat(remaining), upper.slice(common + 1), budget)}`,
  );
  return `${prefix}(?:${alternatives.join("|")})`;
}

/** Nearest directory first, including filesystem ancestors above the checkout. */
export function editorConfigCandidates(cwd: string, filePath: string) {
  const absolutePath = resolveWorkspaceFilePath(filePath, cwd);
  const windows = isWindowsAbsolutePath(absolutePath);
  const path = windows ? absolutePath.replaceAll("\\", "/") : absolutePath;
  const root = (windows ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?)/i : /^\//).exec(path)?.[0];
  if (root === undefined) return [];
  const segments: string[] = [];
  for (const segment of path.slice(root.length).split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments
    .map((_, index) => ({
      path: `${root.replace(/\/$/, "")}/${[...segments.slice(0, index), ".editorconfig"].join("/")}`,
      relativeFilePath: segments.slice(index).join("/"),
    }))
    .toReversed();
}

/** Configurations are supplied nearest first; later matching sections win per property. */
export function resolveEditorConfigTabSize(
  configs: ReadonlyArray<{ config: EditorConfig; relativeFilePath: string }>,
): number {
  const properties = new Map<string, string>();
  const rootIndex = configs.findIndex(({ config }) => config.root);
  const applicable = rootIndex < 0 ? configs : configs.slice(0, rootIndex + 1);
  for (const { config, relativeFilePath } of applicable.toReversed()) {
    for (const section of config.sections) {
      if (!section.matcher.test(relativeFilePath)) continue;
      for (const [key, value] of section.properties) {
        if (value === "unset") properties.delete(key);
        else properties.set(key, value);
      }
    }
  }
  const width = positiveInteger(properties.get("tab_width"));
  return width ?? positiveInteger(properties.get("indent_size")) ?? DEFAULT_CODE_TAB_SIZE;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
