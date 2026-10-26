import type {
  PullRequestActor,
  PullRequestComment,
  PullRequestReaction,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Schema from "effect/Schema";

import type { AzureDevOpsServerContext } from "./AzureDevOpsServerClient.ts";
import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

export const Identity = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.String),
  uniqueName: Schema.optional(Schema.String),
  imageUrl: Schema.optional(Schema.String),
  vote: Schema.optional(Schema.Number),
});

export const PullRequest = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  status: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  creationDate: Schema.String,
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStatus: Schema.optional(Schema.String),
  createdBy: Identity,
  reviewers: Schema.optional(Schema.Array(Identity)),
  lastMergeSourceCommit: Schema.optional(Schema.Struct({ commitId: Schema.String })),
  autoCompleteSetBy: Schema.optional(Schema.NullOr(Identity)),
  completionOptions: Schema.optional(
    Schema.Struct({
      mergeStrategy: Schema.optional(Schema.String),
      squashMerge: Schema.optional(Schema.Boolean),
    }),
  ),
  repository: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    webUrl: Schema.optional(Schema.String),
    project: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
});

export const Iteration = Schema.Struct({
  id: Schema.Int,
  createdDate: Schema.optional(Schema.String),
  sourceRefCommit: Schema.Struct({ commitId: Schema.String }),
  commonRefCommit: Schema.Struct({ commitId: Schema.String }),
});
export type Iteration = typeof Iteration.Type;

const Position = Schema.Struct({ line: Schema.Int, offset: Schema.optional(Schema.Int) });
export const Thread = Schema.Struct({
  id: Schema.Int,
  properties: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        $value: Schema.Unknown,
      }),
    ),
  ),
  identities: Schema.optional(Schema.Record(Schema.String, Identity)),
  isDeleted: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  threadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        filePath: Schema.optional(Schema.NullOr(Schema.String)),
        leftFileStart: Schema.optional(Schema.NullOr(Position)),
        rightFileStart: Schema.optional(Schema.NullOr(Position)),
      }),
    ),
  ),
  comments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.Int,
        parentCommentId: Schema.optional(Schema.Int),
        content: Schema.optional(Schema.NullOr(Schema.String)),
        author: Identity,
        publishedDate: Schema.String,
        lastContentUpdatedDate: Schema.optional(Schema.String),
        isDeleted: Schema.optional(Schema.Boolean),
        commentType: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
        usersLiked: Schema.optional(Schema.Array(Identity)),
      }),
    ),
  ),
});
export type Thread = typeof Thread.Type;

export const Change = Schema.Struct({
  changeTrackingId: Schema.optional(Schema.Int),
  changeType: Schema.optional(Schema.String),
  sourceServerItem: Schema.optional(Schema.String),
  originalPath: Schema.optional(Schema.String),
  item: Schema.Struct({
    path: Schema.String,
    objectId: Schema.optional(Schema.String),
    originalObjectId: Schema.optional(Schema.String),
    isFolder: Schema.optional(Schema.Boolean),
    gitObjectType: Schema.optional(Schema.String),
  }),
});
export type Change = typeof Change.Type;

export function actor(identity: typeof Identity.Type): PullRequestActor {
  return {
    // Azure's stable identity id also works in creator/reviewer REST filters and vote routes.
    login: identity.id,
    name: identity.displayName ?? identity.uniqueName ?? null,
    avatarUrl: identity.imageUrl ?? null,
    ...(identity.vote === undefined ? {} : { reviewOutcome: voteOutcome(identity.vote) }),
  };
}

function voteOutcome(vote: number): NonNullable<PullRequestActor["reviewOutcome"]> {
  switch (vote) {
    case 10:
      return "approved";
    case 5:
      return "approved-with-suggestions";
    case -5:
      return "waiting";
    case -10:
      return "rejected";
    default:
      return "none";
  }
}

export function changeRequest(
  raw: typeof PullRequest.Type,
  context: AzureDevOpsServerContext,
): ProviderChangeRequest {
  const state =
    raw.status === "completed" ? "merged" : raw.status === "abandoned" ? "closed" : "open";
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url: `${context.repositoryUrl}/pullrequest/${raw.pullRequestId}`,
    author: actor(raw.createdBy),
    headBranch: raw.sourceRefName.replace(/^refs\/heads\//, ""),
    baseBranch: raw.targetRefName.replace(/^refs\/heads\//, ""),
    state,
    isDraft: raw.isDraft ?? false,
    mergeability:
      raw.mergeStatus === "succeeded"
        ? "mergeable"
        : raw.mergeStatus === "conflicts"
          ? "conflicting"
          : "unknown",
    additions: 0,
    deletions: 0,
    createdAt: raw.creationDate,
    updatedAt: raw.closedDate ?? raw.creationDate,
    closedAt: state === "closed" ? (raw.closedDate ?? null) : null,
    mergedAt: state === "merged" ? (raw.closedDate ?? null) : null,
    reviewRequestLogins: (raw.reviewers ?? []).map((identity) => identity.id),
    labels: [],
  };
}

export function changeEntry(raw: Change): AzureDevOpsChangeEntry {
  const path = raw.item.path.replace(/^\//, "");
  const oldPath = (raw.sourceServerItem ?? raw.originalPath ?? raw.item.path).replace(/^\//, "");
  const kinds =
    raw.changeType
      ?.toLowerCase()
      .split(",")
      .map((part) => part.trim()) ?? [];
  const renamed = oldPath !== path || kinds.includes("rename");
  return {
    path,
    oldPath,
    changeKind: kinds.includes("delete")
      ? "deleted"
      : kinds.includes("add")
        ? "new"
        : renamed
          ? kinds.includes("edit")
            ? "rename-changed"
            : "rename-pure"
          : "change",
    objectId: raw.item.objectId ?? null,
    originalObjectId: raw.item.originalObjectId ?? null,
  };
}

export function discussion(
  threads: ReadonlyArray<Thread>,
  viewer: string,
): ProviderChangeRequestActivity {
  const comments: PullRequestComment[] = [];
  const reviewThreads: PullRequestReviewThread[] = [];
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    if (thread.properties?.CodeReviewThreadType?.$value === "VoteUpdate") {
      const vote = Number(thread.properties.CodeReviewVoteResult?.$value);
      const state =
        vote === 10 || vote === 5
          ? "approved"
          : vote === -5 || vote === -10
            ? "changes-requested"
            : null;
      const comment = thread.comments?.find(
        (entry) => !entry.isDeleted && (entry.commentType === "system" || entry.commentType === 3),
      );
      const voterKey = thread.properties.CodeReviewVotedByIdentity?.$value;
      const voter = typeof voterKey === "string" ? thread.identities?.[voterKey] : undefined;
      if (state && comment)
        comments.push({
          id: `${thread.id}:${comment.id}`,
          kind: "review",
          author: actor(voter ?? comment.author),
          body: "",
          createdAt: comment.publishedDate,
          editedAt: null,
          url: null,
          path: null,
          reviewState: state,
          canEdit: false,
        });
    }
    const path = thread.threadContext?.filePath?.replace(/^\//, "") || null;
    const entries = (thread.comments ?? [])
      .filter(
        (comment) =>
          !comment.isDeleted &&
          comment.commentType !== "system" &&
          comment.commentType !== 3 &&
          (comment.content?.trim().length ?? 0) > 0,
      )
      .map((comment) => {
        const liked = comment.usersLiked ?? [];
        const reactions: PullRequestReaction[] =
          liked.length === 0
            ? []
            : [
                {
                  content: "thumbs-up",
                  count: liked.length,
                  actors: liked
                    .filter((identity) => identity.id !== viewer)
                    .map((identity) => identity.displayName ?? identity.uniqueName ?? identity.id),
                  viewerHasReacted: liked.some((identity) => identity.id === viewer),
                },
              ];
        return {
          id: `${thread.id}:${comment.id}`,
          author: actor(comment.author),
          body: comment.content ?? "",
          createdAt: comment.publishedDate,
          editedAt: comment.lastContentUpdatedDate ?? null,
          url: null,
          canEdit: comment.author.id === viewer,
          reactions,
        };
      });
    if (entries.length === 0) continue;
    if (path === null) {
      comments.push(
        ...entries.map((comment): PullRequestComment => ({
          ...comment,
          kind: "issue-comment",
          path: null,
          reviewState: null,
        })),
      );
      continue;
    }
    const right = thread.threadContext?.rightFileStart?.line;
    const left = thread.threadContext?.leftFileStart?.line;
    const line =
      right !== undefined && right > 0 ? right : left !== undefined && left > 0 ? left : null;
    const status = thread.status;
    reviewThreads.push({
      id: String(thread.id),
      path,
      line,
      side: right !== undefined && right > 0 ? "right" : "left",
      // Azure tracks older threads onto newer iterations; age alone does not make an anchor stale.
      isOutdated: line === null,
      isResolved:
        status === 2 ||
        status === 3 ||
        status === 4 ||
        status === 5 ||
        status === "fixed" ||
        status === "wontFix" ||
        status === "closed" ||
        status === "byDesign",
      comments: entries,
      commentCount: entries.length,
    });
  }
  return {
    comments: comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentCount: comments.length,
    commentsTruncated: false,
    reviewThreads,
    commits: [],
  };
}
