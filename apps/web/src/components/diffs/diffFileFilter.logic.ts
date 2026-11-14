export interface DiffFileFilterValue {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export const DEFAULT_DIFF_FILE_FILTER: DiffFileFilterValue = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export function createDiffFileMatcher(value: DiffFileFilterValue) {
  let expression: RegExp | null = null;
  let error: string | null = null;
  if (value.query !== "") {
    const source = value.regex ? value.query : value.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      expression = new RegExp(
        value.wholeWord ? `\\b(?:${source})\\b` : source,
        value.caseSensitive ? "u" : "iu",
      );
    } catch {
      error = "Invalid regular expression";
    }
  }
  const matches = (path: string) => expression === null || expression.test(path);
  const matchesFile = (file: { readonly name: string; readonly prevName?: string }) =>
    matches(file.name) || (file.prevName !== undefined && matches(file.prevName));
  return { matches, matchesFile, error, active: expression !== null };
}
