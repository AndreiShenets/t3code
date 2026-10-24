import type { ProviderFilesViewed } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Schema from "effect/Schema";

import type { Change } from "./azureDevOpsServerJson.ts";

export const VIEWED_PROVIDER_ID = "ms.vss-code-web.pr-detail-visit-data-provider";

const Exceptions = Schema.Union([
  Schema.Array(Schema.Unknown),
  Schema.Record(Schema.String, Schema.Unknown),
]);
export const ViewedResponse = Schema.Struct({
  dataProviderExceptions: Schema.optional(Exceptions),
  exceptions: Schema.optional(Exceptions),
  dataProviders: Schema.Struct({
    [VIEWED_PROVIDER_ID]: Schema.Struct({
      visit: Schema.Struct({ viewedState: Schema.NullOr(Schema.String) }),
    }),
  }),
});
export const ViewedStateJson = Schema.fromJsonString(
  Schema.Struct({
    hashes: Schema.Record(Schema.String, Schema.Literal(2)),
  }),
);

function parseToken(token: string) {
  const match = /^(\d+)@([a-f0-9]{8})@(\/.+)$/iu.exec(token);
  return match ? { version: match[1], hash: match[2]!.toUpperCase(), path: match[3]! } : null;
}

export function viewedToken(change: Change): string | null {
  const { objectId, path } = change.item;
  if (!objectId || !/^[a-f0-9]{40}$/iu.test(objectId) || !path.startsWith("/") || path.length < 2)
    return null;
  return `1@${objectId.slice(0, 8).toUpperCase()}@${path}`;
}

export function viewedFiles(
  changes: ReadonlyArray<Change>,
  hashes: Readonly<Record<string, 2>>,
  truncated: boolean,
): ProviderFilesViewed {
  const known = new Map<string, Set<string>>();
  const unsupportedPaths = new Set<string>();
  let unparsed = false;
  for (const token of Object.keys(hashes)) {
    const parsed = parseToken(token);
    if (!parsed) {
      unparsed = true;
      truncated = true;
    } else if (parsed.version !== "1") {
      unsupportedPaths.add(parsed.path);
      truncated = true;
    } else {
      const versions = known.get(parsed.path) ?? new Set<string>();
      versions.add(parsed.hash);
      known.set(parsed.path, versions);
    }
  }
  const files: ProviderFilesViewed["files"][number][] = [];
  const counts = new Map<string, number>();
  for (const change of changes)
    counts.set(change.item.path, (counts.get(change.item.path) ?? 0) + 1);
  for (const change of changes) {
    const token = viewedToken(change);
    if (!token || counts.get(change.item.path) !== 1) {
      truncated = true;
      continue;
    }
    const hash = change.item.objectId!.slice(0, 8).toUpperCase();
    const versions = known.get(change.item.path);
    const current = versions?.has(hash) === true;
    if (!current && (unparsed || unsupportedPaths.has(change.item.path))) continue;
    files.push({
      path: change.item.path.slice(1),
      state: current ? "viewed" : versions?.size ? "dismissed" : "unviewed",
    });
  }
  return { files, truncated };
}

export function unviewTokens(
  path: string,
  currentToken: string,
  hashes: Readonly<Record<string, 2>>,
) {
  const tokens = new Set([currentToken]);
  for (const token of Object.keys(hashes)) {
    const parsed = parseToken(token);
    if (parsed?.version === "1" && parsed.path === path) tokens.add(token);
  }
  return [...tokens];
}
