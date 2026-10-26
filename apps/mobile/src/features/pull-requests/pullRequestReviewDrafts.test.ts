import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  clearSubmittedReview,
  ReviewDraftDocument,
  reviewCommentsForSubmission,
  type ReviewDraft,
} from "./pullRequestReviewDrafts";
const decodeDocument = Schema.decodeUnknownSync(ReviewDraftDocument);
const comment = {
  id: "one",
  path: "renamed.ts",
  oldPath: "old.ts",
  position: { kind: "deleted" as const, oldLine: 9 },
  body: "Keep this",
  headSha: "abc",
  code: "old line",
};
const draft: ReviewDraft = {
  summary: "Review",
  comment: "Separate PR comment",
  comments: [comment],
};
describe("mobile review draft recovery", () => {
  it("omits empty legacy snapshots without losing valid reviewed commits", () => {
    const [empty, captured] = reviewCommentsForSubmission([
      { ...comment, headSha: "", baseSha: " " },
      { ...comment, baseSha: "base" },
    ]);
    expect(empty).not.toHaveProperty("headSha");
    expect(empty).not.toHaveProperty("baseSha");
    expect(empty).not.toHaveProperty("id");
    expect(captured).toMatchObject({ headSha: "abc", baseSha: "base", body: comment.body });
  });
  it("keeps unconfirmed comments and summary and persists an unknown outcome", () => {
    const second = { ...comment, id: "two", baseSha: "base" };
    const submitted = { ...draft, comments: [comment, second] };
    const partial = {
      status: "partial" as const,
      postedCommentIndexes: [0],
      summaryPosted: false,
      outcomeUnknown: true,
      message: "Comment outcome unknown",
    };
    const remaining = clearSubmittedReview(submitted, submitted, partial);
    expect(remaining.comments).toEqual([second]);
    expect(remaining.summary).toBe(draft.summary);
    expect(remaining.outcomeUnknown).toBe(true);
    expect(decodeDocument({ version: 1, drafts: { key: remaining } }).drafts.key).toEqual(
      remaining,
    );
  });
  it("clears a submitted snapshot while retaining edits made during the request", () => {
    const current = {
      ...draft,
      summary: "New summary",
      comments: [
        { ...comment, body: "New feedback" },
        { ...comment, id: "two" },
      ],
    };
    expect(clearSubmittedReview(current, draft)).toEqual(current);
    expect(clearSubmittedReview(draft, draft)).toEqual({
      summary: "",
      comment: draft.comment,
      comments: [],
    });
  });
});
