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
  repository: { id: "repository-id", name: "Repository" },
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
});

describe("Azure discussion normalization", () => {
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
