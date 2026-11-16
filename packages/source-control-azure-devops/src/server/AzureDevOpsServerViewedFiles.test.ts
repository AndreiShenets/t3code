import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Client from "./AzureDevOpsServerClient.ts";
import { make } from "./AzureDevOpsServerPullRequestProvider.ts";
import type * as Json from "./azureDevOpsServerJson.ts";
import { VIEWED_PROVIDER_ID } from "./azureDevOpsServerViewedFiles.ts";

const context: Client.AzureDevOpsServerContext = {
  origin: "https://code.example:8443",
  collectionUrl: "https://code.example:8443/tfs/Collection",
  projectUrl: "https://code.example:8443/tfs/Collection/Project",
  project: "Project",
  repository: "Repo",
  repositoryPath: "tfs/Collection/Project/_git/Repo",
  repositoryUrl: "https://code.example:8443/tfs/Collection/Project/_git/Repo",
};
const reference = {
  cwd: "/repo",
  repository: context.repositoryPath,
  host: "code.example:8443",
  number: 12,
};
const one: Json.Change = {
  changeType: "edit",
  item: { path: "/one.ts", objectId: "a".repeat(40) },
};
const two: Json.Change = { changeType: "add", item: { path: "/two.ts", objectId: "b".repeat(40) } };
const firstToken = "1@AAAAAAAA@/one.ts";
const secondToken = "1@BBBBBBBB@/two.ts";
const oldToken = "1@CCCCCCCC@/one.ts";
const decodeProperties = Schema.decodeUnknownSync(
  Schema.Struct({
    dataProviderContext: Schema.Struct({
      properties: Schema.Struct({
        repositoryId: Schema.String,
        pullRequestId: Schema.Number,
        projectId: Schema.optional(Schema.String),
        modifyHashes: Schema.optional(Schema.Array(Schema.String)),
        modifyViewedStatus: Schema.optional(Schema.Literals([1, 2])),
      }),
    }),
  }),
);

function fixture(
  options: {
    readonly hashes?: Readonly<Record<string, number>>;
    readonly changes?: ReadonlyArray<typeof Json.Change.Encoded>;
    readonly nativeResponse?: unknown;
    readonly nativeWriteResponse?: unknown;
    readonly failModification?: number;
    readonly failOutcome?: "not-sent" | "rejected" | "unknown";
    readonly ignoreWrites?: boolean;
    readonly beforeModification?: (number: number) => Effect.Effect<void>;
    readonly omitProjectId?: boolean;
    readonly nextSkip?: number;
  } = {},
) {
  return Effect.gen(function* () {
    const hashes = { ...options.hashes };
    const queries: Parameters<Client.AzureDevOpsServerClient["Service"]["request"]>[0][] = [];
    const modifications: Array<{ readonly tokens: ReadonlyArray<string>; readonly status: 1 | 2 }> =
      [];
    const response = () => ({
      dataProviders: {
        [VIEWED_PROVIDER_ID]: { visit: { viewedState: JSON.stringify({ hashes }) } },
      },
    });
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(Client.AzureDevOpsServerClient)({
          resolve: () => Effect.succeed(context),
          request: (input) =>
            Effect.gen(function* () {
              queries.push(input);
              const url = new URL(input.url);
              if (url.pathname.includes("/Contribution/HierarchyQuery/")) {
                expect(input.method).toBe("POST");
                const properties = decodeProperties(input.body).dataProviderContext.properties;
                expect(properties.repositoryId).toBe("repo-id");
                expect(properties.pullRequestId).toBe(12);
                if (properties.modifyViewedStatus !== undefined) {
                  const status = properties.modifyViewedStatus;
                  const tokens = properties.modifyHashes ?? [];
                  modifications.push({ status, tokens });
                  yield* options.beforeModification?.(modifications.length) ?? Effect.void;
                  if (modifications.length === options.failModification)
                    return yield* new Client.AzureDevOpsServerError({
                      operation: "request",
                      reason: "failed",
                      outcome: options.failOutcome ?? "unknown",
                    });
                  if (!options.ignoreWrites)
                    for (const token of tokens) {
                      if (status === 2) hashes[token] = 2;
                      else delete hashes[token];
                    }
                  // The native endpoint's response is not a reliable read-back of this write.
                  return (
                    options.nativeWriteResponse ?? {
                      dataProviders: {
                        [VIEWED_PROVIDER_ID]: { visit: { viewedState: '{"hashes":{}}' } },
                      },
                    }
                  );
                }
                return options.nativeResponse ?? response();
              }
              if (input.method && input.method !== "GET")
                return yield* Effect.die("Unexpected vote, reviewer, or PR mutation");
              if (url.pathname.endsWith("/iterations"))
                return {
                  value: [
                    {
                      id: 3,
                      sourceRefCommit: { commitId: "head" },
                      commonRefCommit: { commitId: "base" },
                    },
                  ],
                };
              if (url.pathname.endsWith("/changes"))
                return {
                  changeEntries: options.changes ?? [one, two],
                  ...(options.nextSkip === undefined ? {} : { nextSkip: options.nextSkip }),
                };
              return {
                pullRequestId: 12,
                title: "A change",
                sourceRefName: "refs/heads/test",
                targetRefName: "refs/heads/main",
                status: "active",
                creationDate: "2026-10-19T00:00:00Z",
                createdBy: { id: "author" },
                repository: {
                  id: "repo-id",
                  name: "Repo",
                  ...(options.omitProjectId ? {} : { project: { id: "project-id" } }),
                },
              };
            }),
        }),
      ),
    );
    if (!provider.getFilesViewed || !provider.setFilesViewed)
      return yield* Effect.die("Native viewed-file support is missing");
    return {
      read: () => provider.getFilesViewed!(reference),
      write: (files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>) =>
        provider.setFilesViewed!({ ...reference, files }),
      hashes,
      queries,
      modifications,
      provider,
    };
  });
}

describe("Azure native viewed files", () => {
  it.effect("keeps viewed-file reads available when a deleted item has a null path", () =>
    Effect.gen(function* () {
      const { read } = yield* fixture({
        changes: [
          one,
          {
            changeType: "delete",
            originalPath: "/deleted.ts",
            item: { path: null, originalObjectId: "c".repeat(40) },
          },
        ],
      });

      const result = yield* read();

      expect(result.files).toEqual([{ path: "one.ts", state: "unviewed" }]);
      expect(result.truncated).toBe(true);
    }),
  );

  it.effect("keeps empty batches as no-ops and refuses absent project metadata", () =>
    Effect.gen(function* () {
      const empty = yield* fixture();
      yield* empty.write([]);
      expect(empty.queries).toHaveLength(0);
      const missing = yield* fixture({ omitProjectId: true });
      const error = yield* missing.read().pipe(Effect.flip);
      expect(error.detail).toContain("project identity");
      expect(missing.modifications).toHaveLength(0);
    }),
  );

  it.effect("does not claim complete coverage when the change listing is capped", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ nextSkip: 10_000 });
      expect((yield* f.read()).truncated).toBe(true);
    }),
  );
  it.effect("reads website marks against current blobs and reports stale revisions", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ hashes: { [firstToken]: 2, "1@CCCCCCCC@/two.ts": 2 } });
      expect(yield* f.read()).toEqual({
        files: [
          { path: "one.ts", state: "viewed" },
          { path: "two.ts", state: "dismissed" },
        ],
        truncated: false,
      });
      expect(f.provider.capabilities.viewedFiles).toBe("host");
      const query = f.queries.find((input) => input.method === "POST")!;
      expect(query.url).toBe(
        `${context.collectionUrl}/_apis/Contribution/HierarchyQuery/project/project-id?api-version=7.0-preview.1`,
      );
      expect(f.modifications).toHaveLength(0);
    }),
  );

  it.effect("does not carry a viewed mark to changed content, but retains unchanged content", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        hashes: { [firstToken]: 2, [secondToken]: 2 },
        changes: [{ ...one, item: { ...one.item, objectId: "d".repeat(40) } }, two],
      });
      expect((yield* f.read()).files).toEqual([
        { path: "one.ts", state: "dismissed" },
        { path: "two.ts", state: "viewed" },
      ]);
    }),
  );

  it.effect("accepts a never-marked user's null state, not an unsupported provider payload", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        nativeResponse: {
          dataProviders: { [VIEWED_PROVIDER_ID]: { visit: { viewedState: null } } },
        },
      });
      expect((yield* f.read()).files.every((file) => file.state === "unviewed")).toBe(true);
    }),
  );

  it.effect.each([
    { dataProviders: {} },
    { dataProviders: { [VIEWED_PROVIDER_ID]: { visit: { viewedState: "not-json" } } } },
    { dataProviders: { [VIEWED_PROVIDER_ID]: { visit: { viewedState: '{"other":{}}' } } } },
    {
      dataProviders: {
        [VIEWED_PROVIDER_ID]: { visit: { viewedState: '{"hashes":{"token":"viewed"}}' } },
      },
    },
    {
      dataProviderExceptions: { [VIEWED_PROVIDER_ID]: { message: "Unavailable" } },
      dataProviders: { [VIEWED_PROVIDER_ID]: { visit: { viewedState: null } } },
    },
  ])("refuses missing, malformed, or failed native state %#", (nativeResponse) =>
    Effect.gen(function* () {
      const f = yield* fixture({ nativeResponse });
      yield* f.read().pipe(Effect.flip);
      yield* f.write([{ path: "one.ts", viewed: true }]).pipe(Effect.flip);
      expect(f.modifications).toHaveLength(0);
    }),
  );

  it.effect("does not call a rejected first write a partial update", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failModification: 1, failOutcome: "rejected" });
      const error = yield* f.write([{ path: "one.ts", viewed: true }]).pipe(Effect.flip);
      expect(error.detail).not.toContain("Some marks may have changed");
      expect(f.modifications).toHaveLength(1);
    }),
  );

  it.effect("rejects embedded write exceptions even when HTTP and response shape succeed", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        nativeWriteResponse: {
          dataProviderExceptions: { [VIEWED_PROVIDER_ID]: { message: "Unavailable" } },
          dataProviders: { [VIEWED_PROVIDER_ID]: { visit: { viewedState: '{"hashes":{}}' } } },
        },
      });
      const error = yield* f.write([{ path: "one.ts", viewed: true }]).pipe(Effect.flip);
      expect(error.detail).toContain("could not be fully confirmed");
      expect(f.modifications).toHaveLength(1);
    }),
  );

  it.effect("marks and unmarks native state in batches without altering unrelated marks", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        hashes: { [firstToken]: 2, [oldToken]: 2, "1@EEEEEEEE@/other.ts": 2 },
      });
      yield* f.write([
        { path: "one.ts", viewed: false },
        { path: "two.ts", viewed: true },
      ]);
      expect(f.modifications).toEqual([
        { status: 2, tokens: [secondToken] },
        { status: 1, tokens: [firstToken, oldToken] },
      ]);
      expect(f.hashes).toEqual({ [secondToken]: 2, "1@EEEEEEEE@/other.ts": 2 });
      expect((yield* f.read()).files).toEqual([
        { path: "one.ts", state: "unviewed" },
        { path: "two.ts", state: "viewed" },
      ]);
    }),
  );

  it.effect("validates the complete batch before changing any mark", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f
        .write([
          { path: "one.ts", viewed: true },
          { path: "missing.ts", viewed: true },
        ])
        .pipe(Effect.flip);
      expect(f.modifications).toHaveLength(0);
    }),
  );

  it.effect(
    "omits files with missing blob ids and rejects writes rather than inventing a zero hash",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          changes: [one, { changeType: "delete", item: { path: "/deleted.ts" } }],
        });
        expect(yield* f.read()).toEqual({
          files: [{ path: "one.ts", state: "unviewed" }],
          truncated: true,
        });
        yield* f
          .write([
            { path: "one.ts", viewed: true },
            { path: "deleted.ts", viewed: true },
          ])
          .pipe(Effect.flip);
        expect(f.modifications).toHaveLength(0);
      }),
  );

  it.effect(
    "uses the destination path for renames without treating differently cased paths as the same file",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          hashes: { "1@AAAAAAAA@/old.ts": 2, "1@BBBBBBBB@/Two.ts": 2 },
          changes: [
            {
              ...one,
              changeType: "rename",
              sourceServerItem: "/old.ts",
              item: { ...one.item, path: "/new@name.ts" },
            },
            two,
          ],
        });
        expect((yield* f.read()).files.every((file) => file.state === "unviewed")).toBe(true);
        yield* f.write([{ path: "new@name.ts", viewed: true }]);
        expect(f.modifications[0]?.tokens).toEqual(["1@AAAAAAAA@/new@name.ts"]);
      }),
  );

  it.effect(
    "reports unknown token versions as incomplete rather than claiming the affected file is unviewed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hashes: { "2@AAAAAAAA@/one.ts": 2, [secondToken]: 2 } });
        expect(yield* f.read()).toEqual({
          files: [{ path: "two.ts", state: "viewed" }],
          truncated: true,
        });
      }),
  );

  it.effect(
    "verifies persisted state independently instead of trusting an empty write response",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write([{ path: "one.ts", viewed: true }]);
        expect(f.hashes[firstToken]).toBe(2);
        const ignored = yield* fixture({ ignoreWrites: true });
        const error = yield* ignored.write([{ path: "one.ts", viewed: true }]).pipe(Effect.flip);
        expect(error.detail).toContain("could not be fully confirmed");
        expect(ignored.modifications).toHaveLength(1);
      }),
  );

  it.effect("reports partial mixed-batch failures without replay or rollback", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ hashes: { [firstToken]: 2 }, failModification: 2 });
      const error = yield* f
        .write([
          { path: "one.ts", viewed: false },
          { path: "two.ts", viewed: true },
        ])
        .pipe(Effect.flip);
      expect(error.detail).toContain("Some marks may have changed");
      expect(f.modifications).toHaveLength(2);
      expect(f.hashes).toEqual({ [firstToken]: 2, [secondToken]: 2 });
    }),
  );

  it.effect("serializes a later untick behind an in-flight tick", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* fixture({
        beforeModification: (number) =>
          number === 1
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      });
      const first = yield* Effect.forkChild(f.write([{ path: "one.ts", viewed: true }]));
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(f.write([{ path: "one.ts", viewed: false }]));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(f.hashes[firstToken]).toBeUndefined();
      expect(f.modifications.map((write) => write.status)).toEqual([2, 1]);
    }),
  );
});
