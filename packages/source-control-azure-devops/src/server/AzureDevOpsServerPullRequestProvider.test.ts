import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Client from "./AzureDevOpsServerClient.ts";
import { make } from "./AzureDevOpsServerPullRequestProvider.ts";
import * as Json from "./azureDevOpsServerJson.ts";

const CONTEXT: Client.AzureDevOpsServerContext = {
  origin: "https://code.example:8443",
  collectionUrl: "https://code.example:8443/Collection",
  projectUrl: "https://code.example:8443/Collection/Project",
  project: "Project",
  repository: "Repository",
  repositoryPath: "Collection/Project/_git/Repository",
  repositoryUrl: "https://code.example:8443/Collection/Project/_git/Repository",
};
const INPUT = {
  cwd: "/repo",
  host: "code.example:8443",
  repository: CONTEXT.repositoryPath,
  number: 12,
};
const IDENTITY = { id: "viewer", displayName: "Current reviewer" };
const PR: typeof Json.PullRequest.Type = {
  pullRequestId: 12,
  title: "A change",
  sourceRefName: "refs/heads/change",
  targetRefName: "refs/heads/main",
  status: "active",
  creationDate: "2026-10-01T00:00:00Z",
  createdBy: { id: "author" },
  repository: { id: "repository-id", name: "Repository", project: { id: "project-id" } },
  lastMergeSourceCommit: { commitId: "head" },
  reviewers: [{ ...IDENTITY, vote: -5 }],
};
const ITERATION: Json.Iteration = {
  id: 3,
  sourceRefCommit: { commitId: "head" },
  commonRefCommit: { commitId: "base" },
};
const CHANGE = {
  changeTrackingId: 42,
  changeType: "edit",
  item: { path: "/file.ts", objectId: "blob" },
};
const DELETED_CHANGE = {
  changeTrackingId: 15,
  originalPath: "/Auth.Mcp/Authorization/McpAccessRightRequirement.cs",
  item: { path: null, originalObjectId: "deleted-blob" },
  changeType: "delete",
};
const DRAFT = {
  path: "file.ts",
  body: "Please adjust",
  position: { kind: "added" as const, newLine: 4 },
  baseSha: "base",
  headSha: "head",
};
type HttpInput = Parameters<Client.AzureDevOpsServerClient["Service"]["request"]>[0];

function fixture(
  options: {
    readonly failWrite?: number;
    readonly unknown?: boolean;
    readonly iteration?: Json.Iteration;
    readonly threads?: ReadonlyArray<Json.Thread>;
    readonly changes?: ReadonlyArray<Json.Change>;
    readonly pr?: typeof Json.PullRequest.Type;
    readonly statuses?: ReadonlyArray<unknown>;
    readonly policies?: ReadonlyArray<unknown>;
    readonly failChecks?: "failed" | "rate-limited";
    readonly failRead?: (url: URL) => boolean;
    readonly response?: (url: URL) => unknown;
  } = {},
) {
  return Effect.gen(function* () {
    const writes: HttpInput[] = [];
    const reads: HttpInput[] = [];
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(Client.AzureDevOpsServerClient)({
          resolve: () => Effect.succeed(CONTEXT),
          request: (input) => {
            if (input.method && input.method !== "GET") {
              writes.push(input);
              if (writes.length === options.failWrite)
                return Effect.fail(
                  new Client.AzureDevOpsServerError({
                    operation: "request",
                    reason: "failed",
                    status: options.unknown ? 500 : 403,
                    outcome: options.unknown ? "unknown" : "rejected",
                  }),
                );
              return Effect.succeed({ id: writes.length });
            }
            reads.push(input);
            const url = new URL(input.url);
            if (options.failRead?.(url))
              return Effect.fail(
                new Client.AzureDevOpsServerError({ operation: "request", reason: "failed" }),
              );
            const response = options.response?.(url);
            if (response !== undefined) return Effect.succeed(response);
            if (url.pathname.endsWith("/statuses") || url.pathname.endsWith("/evaluations")) {
              if (options.failChecks)
                return Effect.fail(
                  new Client.AzureDevOpsServerError({
                    operation: "request",
                    reason: options.failChecks,
                  }),
                );
              const rows = url.pathname.endsWith("/statuses")
                ? (options.statuses ?? [])
                : (options.policies ?? []);
              const skip = Number(url.searchParams.get("$skip") ?? 0);
              const top = Number(url.searchParams.get("$top") ?? rows.length);
              return Effect.succeed({ value: rows.slice(skip, skip + top) });
            }
            if (url.pathname.endsWith("/connectionData"))
              return Effect.succeed({ authenticatedUser: IDENTITY });
            if (url.pathname.endsWith("/iterations"))
              return Effect.succeed({ value: [options.iteration ?? ITERATION] });
            if (url.pathname.endsWith("/changes"))
              return Effect.succeed({ changeEntries: options.changes ?? [CHANGE] });
            if (url.pathname.endsWith("/items"))
              return Effect.succeed({
                content:
                  url.searchParams.get("versionDescriptor.version") === "base" ? "old\n" : "new\n",
              });
            if (url.pathname.endsWith("/threads"))
              return Effect.succeed({ value: options.threads ?? [] });
            const tid = /\/threads\/(\d+)$/.exec(url.pathname)?.[1];
            if (tid)
              return Effect.succeed(options.threads?.find((thread) => String(thread.id) === tid));
            return Effect.succeed(options.pr ?? PR);
          },
        }),
      ),
    );
    return { provider, writes, reads };
  });
}

describe("Azure DevOps Server reviews", () => {
  it.effect("anchors a renamed file's original left-side path using its tracking id", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({
        changes: [
          {
            ...CHANGE,
            changeType: "rename, edit",
            sourceServerItem: "/old.ts",
            item: { path: "/new.ts" },
          },
        ],
      });
      yield* provider.submitReview({
        ...INPUT,
        verdict: "comment",
        body: "",
        comments: [{ ...DRAFT, path: "old.ts", position: { kind: "deleted", oldLine: 9 } }],
      });
      expect(writes[0]?.body).toMatchObject({
        threadContext: { filePath: "/new.ts", leftFileStart: { line: 9 } },
        pullRequestThreadContext: { changeTrackingId: 42 },
      });
    }),
  );

  it.effect("retries only a failed vote after confirmed feedback was removed", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({ failWrite: 2 });
      const first = yield* provider.submitReview({
        ...INPUT,
        verdict: "request-changes",
        body: "Needs changes",
        comments: [],
      });
      expect(first).toMatchObject({
        status: "partial",
        summaryPosted: true,
        outcomeUnknown: false,
      });
      yield* provider.submitReview({
        ...INPUT,
        verdict: "request-changes",
        body: "",
        comments: [],
      });
      expect(writes.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(writes.at(-1)).toMatchObject({ method: "PUT", body: { vote: -5 } });
      expect(provider.capabilities.review.verdictOnly).toBe(true);
    }),
  );

  it.effect("edits only owned comments and replies to the selected PR thread", () =>
    Effect.gen(function* () {
      const thread = {
        id: 7,
        comments: [
          { id: 2, author: IDENTITY, content: "Original", publishedDate: "2026-10-01T00:00:00Z" },
          {
            id: 3,
            author: { id: "other" },
            content: "Other",
            publishedDate: "2026-10-01T00:00:00Z",
          },
        ],
      };
      const { provider, writes } = yield* fixture({ threads: [thread] });
      if (!provider.updateComment) return yield* Effect.die("Comment editing is missing");
      yield* provider.updateComment({
        ...INPUT,
        commentId: "7:2",
        kind: "review-comment",
        body: "Updated",
      });
      yield* provider
        .updateComment({ ...INPUT, commentId: "7:3", kind: "review-comment", body: "Not mine" })
        .pipe(Effect.flip);
      yield* provider.replyToThread({ ...INPUT, threadId: "7", body: "Reply" });
      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatchObject({ method: "PATCH", body: { content: "Updated" } });
      expect(writes[1]).toMatchObject({
        method: "POST",
        body: { content: "Reply", parentCommentId: 2 },
      });
    }),
  );

  it.effect("resolves, reopens, likes and unlikes without offering description reactions", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({
        threads: [
          {
            id: 7,
            comments: [
              {
                id: 2,
                author: IDENTITY,
                content: "Comment",
                publishedDate: "2026-10-01T00:00:00Z",
              },
            ],
          },
        ],
      });
      yield* provider.setThreadResolution({ ...INPUT, threadId: "7", resolved: true });
      yield* provider.setThreadResolution({ ...INPUT, threadId: "7", resolved: false });
      yield* provider.setReaction({
        ...INPUT,
        subjectId: "7:2",
        content: "thumbs-up",
        reacted: true,
      });
      yield* provider.setReaction({
        ...INPUT,
        subjectId: "7:2",
        content: "thumbs-up",
        reacted: false,
      });
      expect(writes.map((write) => write.method)).toEqual(["PATCH", "PATCH", "POST", "DELETE"]);
      expect(writes.slice(0, 2).map((write) => write.body)).toEqual([
        { status: "fixed" },
        { status: "active" },
      ]);
      expect(new URL(writes[2]!.url).searchParams.get("api-version")).toBe("7.0");
      expect(provider.capabilities.descriptionReactions).toBe(false);
    }),
  );
  it.effect("posts comment-only reviews without resetting an existing vote", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture();
      yield* provider.submitReview({
        ...INPUT,
        verdict: "comment",
        body: "An observation",
        comments: [],
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.url).toContain("/threads?");
      expect(writes[0]?.body).toMatchObject({ comments: [{ content: "An observation" }] });
    }),
  );

  it.effect.each([
    { verdict: "approve", vote: 10 },
    { verdict: "request-changes", vote: -5 },
  ] as const)("maps $verdict to Azure vote $vote", ({ verdict, vote }) =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture();
      yield* provider.submitReview({ ...INPUT, verdict, body: "", comments: [] });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ method: "PUT", body: { vote } });
      expect(writes[0]?.url).toContain("/reviewers/viewer?");
    }),
  );

  it.effect("anchors comments to the reviewed iteration and votes only after all comments", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture();
      yield* provider.submitReview({
        ...INPUT,
        verdict: "approve",
        body: "Summary",
        comments: [DRAFT],
      });
      expect(writes).toHaveLength(3);
      expect(writes[1]?.body).toMatchObject({
        threadContext: { filePath: "/file.ts", rightFileStart: { line: 4, offset: 1 } },
        pullRequestThreadContext: {
          changeTrackingId: 42,
          iterationContext: { firstComparingIteration: 3, secondComparingIteration: 3 },
        },
      });
      expect(writes[2]?.body).toEqual({ vote: 10 });
    }),
  );

  it.effect("refuses a stale draft before posting even the review summary", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture();
      const error = yield* provider
        .submitReview({
          ...INPUT,
          verdict: "approve",
          body: "Summary",
          comments: [DRAFT, { ...DRAFT, headSha: "old-head" }],
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("re-check");
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect("refuses drafts with no captured diff snapshot", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture();
      const { baseSha: _base, headSha: _head, ...draft } = DRAFT;
      yield* provider
        .submitReview({ ...INPUT, verdict: "comment", body: "", comments: [draft] })
        .pipe(Effect.flip);
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect("reports confirmed progress and never posts a vote after an inline failure", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({ failWrite: 3 });
      const result = yield* provider.submitReview({
        ...INPUT,
        verdict: "approve",
        body: "Summary",
        comments: [DRAFT, DRAFT],
      });
      expect(result).toMatchObject({
        status: "partial",
        summaryPosted: true,
        postedCommentIndexes: [0],
        outcomeUnknown: false,
      });
      expect(writes).toHaveLength(3);
      expect(writes.every((write) => write.method === "POST")).toBe(true);
    }),
  );

  it.effect("reports uncertainty even if the first write has no acknowledgement", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({ failWrite: 1, unknown: true });
      const result = yield* provider.submitReview({
        ...INPUT,
        verdict: "comment",
        body: "Summary",
        comments: [],
      });
      expect(result).toMatchObject({
        status: "partial",
        summaryPosted: false,
        postedCommentIndexes: [],
        outcomeUnknown: true,
      });
      expect(writes).toHaveLength(1);
    }),
  );

  it.effect("reports a vote failure without losing the already posted comments", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({ failWrite: 2 });
      const result = yield* provider.submitReview({
        ...INPUT,
        verdict: "approve",
        body: "",
        comments: [DRAFT],
      });
      expect(result).toMatchObject({
        status: "partial",
        summaryPosted: false,
        postedCommentIndexes: [0],
        outcomeUnknown: false,
      });
    }),
  );

  it.effect("shows current native votes without inventing a submitted review", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture();
      const detail = yield* provider.getChangeRequest(INPUT);
      const activity = yield* provider.getChangeRequestActivity(INPUT);
      expect(detail.reviewers[0]).toMatchObject({ login: "viewer", reviewOutcome: "waiting" });
      expect(activity.comments).toEqual([]);
      expect(detail.url).toBe(`${CONTEXT.repositoryUrl}/pullrequest/12`);
    }),
  );

  it.effect("rejects a mismatched repository before mutations", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({
        pr: { ...PR, repository: { id: "other-id", name: "other" } },
      });
      yield* provider.comment({ ...INPUT, body: "Do not send" }).pipe(Effect.flip);
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect("refuses arbitrary emoji and description reactions", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture();
      yield* provider
        .setReaction({ ...INPUT, content: "heart", reacted: true, subjectId: "1:1" })
        .pipe(Effect.flip);
      yield* provider
        .setReaction({ ...INPUT, content: "thumbs-up", reacted: true })
        .pipe(Effect.flip);
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect("returns the exact diff snapshot alongside the patch", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture();
      const diff = yield* provider.getDiff(INPUT);
      expect(diff).toMatchObject({ baseSha: "base", headSha: "head" });
      expect(diff.patch).toContain("+new");
      expect(diff.patch).toContain("-old");
    }),
  );

  it.effect("keeps deleted files whose item path is null in the diff and PR details", () =>
    Effect.gen(function* () {
      const { provider, reads } = yield* fixture({
        response: (url) =>
          url.pathname.endsWith("/changes")
            ? {
                changeEntries: [CHANGE, DELETED_CHANGE],
              }
            : undefined,
      });

      const diff = yield* provider.getDiff(INPUT);
      const detail = yield* provider.getChangeRequest(INPUT);

      expect(diff.patch).toContain("+new");
      expect(diff.patch).toContain(
        "--- a/Auth.Mcp/Authorization/McpAccessRightRequirement.cs\n+++ /dev/null",
      );
      expect(diff.patch).toContain("-old");
      expect(detail.changedFiles).toBe(2);
      const deletedFileReads = reads
        .map((read) => new URL(read.url))
        .filter(
          (url) =>
            url.pathname.endsWith("/items") &&
            url.searchParams.get("path") === "/Auth.Mcp/Authorization/McpAccessRightRequirement.cs",
        );
      expect(deletedFileReads).toHaveLength(1);
      expect(deletedFileReads[0]?.searchParams.get("versionDescriptor.version")).toBe("base");
    }),
  );

  it.effect("anchors left-side comments on deleted files whose item path is null", () =>
    Effect.gen(function* () {
      const { provider, writes } = yield* fixture({
        response: (url) =>
          url.pathname.endsWith("/changes") ? { changeEntries: [DELETED_CHANGE] } : undefined,
      });

      yield* provider.submitReview({
        ...INPUT,
        verdict: "comment",
        body: "",
        comments: [
          {
            ...DRAFT,
            path: "Auth.Mcp/Authorization/McpAccessRightRequirement.cs",
            position: { kind: "deleted", oldLine: 1 },
          },
        ],
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toMatchObject({
        threadContext: {
          filePath: "/Auth.Mcp/Authorization/McpAccessRightRequirement.cs",
          leftFileStart: { line: 1 },
        },
        pullRequestThreadContext: { changeTrackingId: 15 },
      });
    }),
  );

  it.effect("rejects changes without any usable path before reading file contents", () =>
    Effect.gen(function* () {
      const { provider, reads } = yield* fixture({
        response: (url) =>
          url.pathname.endsWith("/changes")
            ? { changeEntries: [{ changeType: "delete", item: { path: null } }] }
            : undefined,
      });

      const error = yield* provider.getDiff(INPUT).pipe(Effect.flip);

      expect(error.operation).toBe("decode");
      expect(reads.some((read) => new URL(read.url).pathname.endsWith("/items"))).toBe(false);
    }),
  );
});

describe("Azure DevOps Server watch data", () => {
  const buildPolicy = (overrides: Record<string, unknown> = {}) => ({
    evaluationId: "build",
    status: "approved",
    configuration: {
      id: 10,
      isEnabled: true,
      isBlocking: true,
      type: { id: "0609b952-1397-4640-95ec-e00a01b2c241", displayName: "Build" },
    },
    context: { lastMergeSourceCommitId: "head", buildDefinitionName: "Tests", buildId: 42 },
    ...overrides,
  });

  it.effect("marks unavailable checks for retry without making the PR unreadable", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({ failChecks: "failed" });

      expect(yield* provider.getChangeRequest(INPUT)).toMatchObject({
        checks: [],
        checksIncomplete: true,
        state: "open",
      });
      expect(yield* provider.getChangeRequestWatchFingerprint!(INPUT)).toMatchObject({
        remarks: "[]",
      });
    }),
  );

  it.effect("preserves rate limits in watch fingerprints so the shared reactor pauses", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({ failChecks: "rate-limited" });

      const error = yield* provider.getChangeRequestWatchFingerprint!(INPUT).pipe(Effect.flip);

      expect(error.reason).toBe("rate-limited");
    }),
  );

  it.effect(
    "returns current statuses and blocking build policy failures instead of an empty list",
    () =>
      Effect.gen(function* () {
        const { provider, reads } = yield* fixture({
          statuses: [
            { id: 1, context: { genre: "ci", name: "lint" }, iterationId: 3, state: "succeeded" },
            { id: 2, context: { genre: "ci", name: "lint" }, iterationId: 3, state: "failed" },
            { id: 3, context: { name: "old" }, iterationId: 2, state: "succeeded" },
          ],
          policies: [
            {
              evaluationId: "build",
              status: "rejected",
              configuration: {
                id: 10,
                isEnabled: true,
                isBlocking: true,
                type: { id: "0609b952-1397-4640-95ec-e00a01b2c241", displayName: "Build" },
              },
              context: {
                lastMergeSourceCommitId: "head",
                buildDefinitionName: "Tests",
                buildId: 42,
              },
            },
          ],
        });
        const detail = yield* provider.getChangeRequest(INPUT);
        expect(detail.checks).toMatchObject([
          { name: "Policy: Tests (#10)", status: "failure", required: true },
          { name: "Status: ci/lint", status: "failure", required: false },
        ]);
        const url = new URL(reads.find((read) => read.url.includes("/evaluations"))!.url);
        expect(url.searchParams.get("api-version")).toBe("7.0-preview.1");
        expect(url.searchParams.get("artifactId")).toBe(
          "vstfs:///CodeReview/CodeReviewId/project-id/12",
        );
      }),
  );

  it.effect.each([
    ["succeeded", "success"],
    ["failed", "failure"],
    ["error", "failure"],
    ["pending", "pending"],
    ["notSet", "pending"],
    ["future-value", "pending"],
  ])("maps posted %s to %s", ([state, status]) =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({
        statuses: [{ id: 1, state, iterationId: 3, context: { name: "test" } }],
      });
      expect((yield* provider.getChangeRequest(INPUT)).checks).toMatchObject([{ status }]);
    }),
  );

  it.effect.each([
    ["approved", "success"],
    ["rejected", "failure"],
    ["broken", "failure"],
    ["running", "pending"],
    ["queued", "pending"],
    ["future-value", "pending"],
  ])("maps build policy %s to %s", ([state, status]) =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({ policies: [buildPolicy({ status: state })] });
      expect((yield* provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { status, required: true },
      ]);
    }),
  );

  it.effect(
    "never treats empty, not-applicable, disabled or human-policy approvals as passed CI",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* fixture({
          statuses: [{ id: 1, state: "notApplicable", iterationId: 3, context: { name: "skip" } }],
          policies: [
            buildPolicy({ status: "notApplicable" }),
            buildPolicy({
              evaluationId: "disabled",
              configuration: { ...buildPolicy().configuration, isEnabled: false },
            }),
            buildPolicy({
              evaluationId: "human",
              configuration: {
                ...buildPolicy().configuration,
                type: { id: "human", displayName: "Reviewers" },
              },
            }),
          ],
        });
        expect((yield* provider.getChangeRequest(INPUT)).checks).toEqual([]);
        expect((yield* (yield* fixture()).provider.getChangeRequest(INPUT)).checks).toEqual([]);
        expect(provider.capabilities.checksAlwaysReport).toBeUndefined();
      }),
  );

  it.effect.each([
    [{ lastMergeSourceCommitId: "old" }, "pending"],
    [{ lastMergeSourceCommitId: "old", isExpired: true }, "pending"],
    [{}, "pending"],
    [{ lastMergeSourceCommitId: "head", isExpired: true }, "action-required"],
    [{ lastMergeSourceCommitId: "head", buildIsNotCurrent: true }, "action-required"],
  ])("does not pass stale or unverifiable build context %j", ([context, status]) =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({ policies: [buildPolicy({ context })] });
      expect((yield* provider.getChangeRequest(INPUT)).checks).toMatchObject([{ status }]);
    }),
  );

  it.effect("does not trust PR-level success or a mismatched iteration after a push", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({
        statuses: [{ id: 1, state: "succeeded", context: { name: "global" } }],
      });
      expect((yield* provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { status: "pending" },
      ]);
      const moved = yield* fixture({
        iteration: { ...ITERATION, sourceRefCommit: { commitId: "new-head" } },
        policies: [buildPolicy()],
      });
      expect(yield* moved.provider.getChangeRequest(INPUT)).toMatchObject({
        headSha: "new-head",
        checks: [],
        checksIncomplete: true,
      });
    }),
  );

  it.effect("keeps a queued build pending even when its previous run expired", () =>
    Effect.gen(function* () {
      const { provider } = yield* fixture({
        policies: [
          buildPolicy({
            status: "queued",
            context: { lastMergeSourceCommitId: "head", isExpired: true },
          }),
        ],
      });
      expect((yield* provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { status: "pending" },
      ]);
    }),
  );

  it.effect("does not repeat a PR-wide failure predating the latest push", () =>
    Effect.gen(function* () {
      const posted = {
        id: 1,
        state: "failed",
        context: { name: "global" },
        updatedDate: "2026-10-02T00:00:00Z",
      };
      const old = yield* fixture({
        statuses: [posted],
        iteration: { ...ITERATION, createdDate: "2026-10-01T00:00:00Z" },
      });
      const pushed = yield* fixture({
        statuses: [posted],
        iteration: { ...ITERATION, createdDate: "2026-10-03T00:00:00Z" },
      });
      expect((yield* old.provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { status: "failure" },
      ]);
      expect((yield* pushed.provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { status: "pending" },
      ]);
    }),
  );

  it.effect("requires a current-iteration status to confirm an approved status policy", () =>
    Effect.gen(function* () {
      const policy = buildPolicy({
        configuration: {
          id: 11,
          isEnabled: true,
          isBlocking: true,
          type: { id: "cbdc66da-9728-4af8-aada-9a5a32e4a226", displayName: "Status" },
          settings: { statusGenre: "ci", statusName: "lint" },
        },
      });
      const raw = { id: 1, state: "succeeded", context: { genre: "ci", name: "lint" } };
      const old = yield* fixture({ policies: [policy], statuses: [raw] });
      const current = yield* fixture({
        policies: [policy],
        statuses: [{ ...raw, iterationId: 3 }],
      });
      expect((yield* old.provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { required: true, status: "pending" },
        { status: "pending" },
      ]);
      expect((yield* current.provider.getChangeRequest(INPUT)).checks).toMatchObject([
        { required: true, status: "success" },
        { status: "success" },
      ]);
    }),
  );

  it.effect(
    "reads all policy pages and reports non-CI policy failures with stable configuration ids",
    () =>
      Effect.gen(function* () {
        const policies = Array.from({ length: 101 }, (_, id) =>
          buildPolicy({
            evaluationId: String(id),
            configuration: {
              ...buildPolicy().configuration,
              id,
              type: { id: "human", displayName: "Reviewers" },
            },
            status: id === 100 ? "rejected" : "approved",
            context: null,
          }),
        );
        const { provider, reads } = yield* fixture({ policies });
        expect((yield* provider.getChangeRequest(INPUT)).checks).toMatchObject([
          { name: "Policy: Reviewers (#100)", status: "failure" },
        ]);
        expect(
          reads
            .filter((read) => read.url.includes("/evaluations"))
            .map((read) => new URL(read.url).searchParams.get("$skip")),
        ).toEqual(["0", "100"]);
      }),
  );

  it.effect.each([
    "policy-page",
    "repeated-page",
    "malformed-status",
    "status-count",
    "missing-project",
    "page-limit",
  ])("does not report partial success after %s", (mode) =>
    Effect.gen(function* () {
      const page = Array.from({ length: 100 }, (_, id) =>
        buildPolicy({ evaluationId: String(id) }),
      );
      const { provider } = yield* fixture({
        statuses: [{ id: 1, state: "succeeded", iterationId: 3, context: { name: "test" } }],
        policies: page,
        ...(mode === "missing-project"
          ? { pr: { ...PR, repository: { id: "repository-id", name: "Repository" } } }
          : {}),
        failRead: (url) => mode === "policy-page" && url.searchParams.get("$skip") === "100",
        response: (url) => {
          if (url.pathname.endsWith("/statuses")) {
            if (mode === "malformed-status") return { value: [{}] };
            if (mode === "status-count") return { value: [], count: 1 };
          }
          if (url.pathname.endsWith("/evaluations")) {
            if (mode === "repeated-page") return { value: page };
            if (mode === "page-limit")
              return {
                value: page.map((row) => ({
                  ...row,
                  evaluationId: `${url.searchParams.get("$skip")}:${row.evaluationId}`,
                })),
              };
          }
          return undefined;
        },
      });
      expect((yield* provider.getChangeRequest(INPUT)).checks).toEqual([]);
    }),
  );

  it.effect("fingerprints same-head check and discussion changes", () =>
    Effect.gen(function* () {
      const quiet = yield* fixture();
      const failed = yield* fixture({
        statuses: [{ id: 1, context: { name: "test" }, iterationId: 3, state: "failed" }],
      });
      const commented = yield* fixture({
        threads: [
          {
            id: 1,
            comments: [
              {
                id: 1,
                author: { id: "other" },
                content: "Feedback",
                publishedDate: "2026-10-02T00:00:00Z",
              },
            ],
          },
        ],
      });
      if (
        !quiet.provider.getChangeRequestWatchFingerprint ||
        !failed.provider.getChangeRequestWatchFingerprint ||
        !commented.provider.getChangeRequestWatchFingerprint
      )
        return yield* Effect.die("Watch fingerprints are missing");
      const initial = yield* quiet.provider.getChangeRequestWatchFingerprint(INPUT);
      expect((yield* failed.provider.getChangeRequestWatchFingerprint(INPUT))?.status).not.toBe(
        initial?.status,
      );
      expect((yield* commented.provider.getChangeRequestWatchFingerprint(INPUT))?.remarks).not.toBe(
        initial?.remarks,
      );
    }),
  );
});

describe("Azure discussion normalization", () => {
  it.each([
    ["10", "approved"],
    [5, "approved"],
    ["-5", "changes-requested"],
    [-10, "changes-requested"],
  ])("turns a native vote %s into a timestamped review", (vote, reviewState) => {
    const thread = {
      id: 12,
      properties: {
        CodeReviewThreadType: { $value: "VoteUpdate" },
        CodeReviewVoteResult: { $value: vote },
        CodeReviewVotedByIdentity: { $value: "1" },
      },
      identities: { "1": { id: "reviewer", displayName: "Reviewer" } },
      comments: [
        {
          id: 1,
          author: IDENTITY,
          content: "Reviewer voted",
          commentType: "system",
          publishedDate: "2026-10-02T00:00:00Z",
        },
      ],
    };
    expect(Json.discussion([thread], "viewer").comments).toMatchObject([
      {
        id: "12:1",
        kind: "review",
        author: { login: "reviewer" },
        reviewState,
        createdAt: "2026-10-02T00:00:00Z",
        canEdit: false,
      },
    ]);
    expect(Json.discussion([{ ...thread, isDeleted: true }], "viewer").comments).toEqual([]);
    expect(
      Json.discussion(
        [
          {
            ...thread,
            properties: { ...thread.properties, CodeReviewVoteResult: { $value: "0" } },
          },
        ],
        "viewer",
      ).comments,
    ).toEqual([]);
  });

  it("preserves tracked anchors, native resolutions, authorship and comment-only likes", () => {
    const result = Json.discussion(
      [
        {
          id: 7,
          status: "fixed",
          threadContext: { filePath: "/file.ts", rightFileStart: { line: 4 } },
          comments: [
            {
              id: 2,
              author: IDENTITY,
              content: "Inline",
              publishedDate: "2026-10-01T00:00:00Z",
              usersLiked: [IDENTITY, { id: "other", displayName: "Other" }],
            },
          ],
        },
        {
          id: 8,
          status: "active",
          comments: [
            {
              id: 1,
              author: { id: "other" },
              content: "Overview",
              publishedDate: "2026-10-01T00:00:00Z",
            },
          ],
        },
        {
          id: 9,
          comments: [
            {
              id: 1,
              author: IDENTITY,
              content: "System event",
              commentType: 3,
              publishedDate: "2026-10-01T00:00:00Z",
            },
          ],
        },
      ],
      "viewer",
    );
    expect(result.reviewThreads).toHaveLength(1);
    expect(result.reviewThreads[0]).toMatchObject({
      id: "7",
      line: 4,
      isResolved: true,
      isOutdated: false,
    });
    expect(result.reviewThreads[0]?.comments[0]).toMatchObject({
      id: "7:2",
      canEdit: true,
      reactions: [{ content: "thumbs-up", count: 2, actors: ["Other"], viewerHasReacted: true }],
    });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ id: "8:1", kind: "issue-comment", canEdit: false });
  });
});
