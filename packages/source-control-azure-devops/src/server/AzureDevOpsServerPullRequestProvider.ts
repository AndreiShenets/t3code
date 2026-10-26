import {
  SourceControlProviderKind,
  type PullRequestCapabilities,
  type PullRequestSubmitReviewPartialResult,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderDiffSlice,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Client from "./AzureDevOpsServerClient.ts";
import * as Json from "./azureDevOpsServerJson.ts";
import * as Checks from "./azureDevOpsServerChecks.ts";
import * as Viewed from "./azureDevOpsServerViewedFiles.ts";
import {
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  byteLength,
  formatAzureDevOpsDiffCursor,
  parseAzureDevOpsDiffCursor,
  MAX_DIFF_SLICE_BYTES,
  MAX_DIFF_SLICE_EDITS,
  MAX_DIFF_SLICE_FILES,
  MAX_FILE_DIFF_EDITS,
} from "./azureDevOpsDiff.ts";
import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

const KIND = SourceControlProviderKind.make("azure-devops-custom-server");
const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["merge", "squash"],
  search: false,
  reactions: true,
  reactionContents: ["thumbs-up"],
  descriptionReactions: false,
  review: {
    verdictOnly: true,
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
  viewedFiles: "host",
};
const PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: true,
  resolve: true,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: false,
};
const Item = Schema.Struct({
  content: Schema.optional(Schema.String),
  contentMetadata: Schema.optional(Schema.Struct({ isBinary: Schema.optional(Schema.Boolean) })),
});
const Changes = Schema.Struct({
  changeEntries: Schema.Array(Json.Change),
  nextSkip: Schema.optional(Schema.Number),
});
const Viewer = Schema.Struct({ authenticatedUser: Json.Identity });
const encode = encodeURIComponent;
const isServerError = Schema.is(Client.AzureDevOpsServerError);
const fingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Request = ProviderRepositoryRef & { readonly number: number };

function failure(operation: string, detail: string) {
  return new PullRequestProviderError({ provider: KIND, operation, reason: "failed", detail });
}

export const make = Effect.gen(function* () {
  const client = yield* Client.AzureDevOpsServerClient;
  const fileReads = yield* Semaphore.make(8);
  const viewedWrites = new Map<string, { readonly gate: Semaphore.Semaphore; pending: number }>();

  const request = (input: Parameters<typeof client.request>[0]) =>
    client.request(input).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: KIND,
            operation: cause.operation,
            reason: cause.reason,
            detail: cause.detail,
            cause,
          }),
      ),
    );
  const decode = <A>(schema: Schema.Codec<A, unknown>, data: unknown) =>
    Schema.decodeUnknownEffect(schema)(data).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: KIND,
            operation: "decode",
            reason: "failed",
            detail: "Azure DevOps Server returned an unsupported response.",
            cause,
          }),
      ),
    );
  const resolve = (input: {
    readonly cwd: string;
    readonly repository?: string;
    readonly host?: string;
  }) =>
    client.resolve(input).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: KIND,
            operation: cause.operation,
            reason: cause.reason,
            detail: cause.detail,
            cause,
          }),
      ),
    );
  const read = <A>(cwd: string, url: string, schema: Schema.Codec<A, unknown>) =>
    request({ cwd, url }).pipe(Effect.flatMap((data) => decode(schema, data)));
  const write = (
    cwd: string,
    url: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
  ) => request({ cwd, url, method, ...(body === undefined ? {} : { body }) }).pipe(Effect.asVoid);
  const prPath = (context: Client.AzureDevOpsServerContext, number: number) =>
    `git/repositories/${encode(context.repository)}/pullRequests/${number}`;
  const readPr = Effect.fn("AzureDevOpsServerPullRequestProvider.readPr")(function* (
    input: Request,
  ) {
    const context = yield* resolve(input);
    const raw = yield* read(
      input.cwd,
      Client.serverApiUrl(context, prPath(context, input.number)),
      Json.PullRequest,
    );
    if (
      raw.pullRequestId !== input.number ||
      ![raw.repository.id.toLowerCase(), raw.repository.name.toLowerCase()].includes(
        context.repository.toLowerCase(),
      )
    ) {
      return yield* failure(
        "getChangeRequest",
        "Azure DevOps Server returned a different pull request or repository.",
      );
    }
    return { context, raw };
  });
  const viewer = (cwd: string, context: Client.AzureDevOpsServerContext) =>
    read(
      cwd,
      `${context.collectionUrl}/_apis/connectionData?api-version=7.0-preview.1`,
      Viewer,
    ).pipe(Effect.map((data) => data.authenticatedUser.id));
  const iterations = (input: Request, context: Client.AzureDevOpsServerContext) =>
    read(
      input.cwd,
      Client.serverApiUrl(context, `${prPath(context, input.number)}/iterations`),
      Schema.Struct({ value: Schema.Array(Json.Iteration) }),
    ).pipe(Effect.map((data) => data.value.toSorted((a, b) => a.id - b.id)));
  const threads = (input: Request, context: Client.AzureDevOpsServerContext) =>
    read(
      input.cwd,
      Client.serverApiUrl(context, `${prPath(context, input.number)}/threads`),
      Schema.Struct({ value: Schema.Array(Json.Thread) }),
    ).pipe(Effect.map((data) => data.value));
  const checks = Effect.fn("AzureDevOpsServerPullRequestProvider.checks")(function* (
    input: Request,
    context: Client.AzureDevOpsServerContext,
    raw: typeof Json.PullRequest.Type,
    latest: Json.Iteration | undefined,
  ) {
    if (raw.status !== "active") return [];
    const projectId = raw.repository.project?.id;
    if (!projectId)
      return yield* failure(
        "checks",
        "Azure DevOps Server omitted the project identity needed to read policies.",
      );
    if (!latest || raw.lastMergeSourceCommit?.commitId !== latest.sourceRefCommit.commitId)
      return yield* failure(
        "checks",
        "Azure DevOps Server has not supplied a consistent current PR iteration.",
      );
    const statuses = yield* read(
      input.cwd,
      Client.serverApiUrl(context, `${prPath(context, input.number)}/statuses`),
      Schema.Struct({ value: Schema.Array(Checks.Status), count: Schema.optional(Schema.Int) }),
    );
    if (statuses.count !== undefined && statuses.count !== statuses.value.length)
      return yield* failure("checks", "Azure DevOps Server returned an incomplete status list.");
    const policies: Array<typeof Checks.Policy.Type> = [];
    const seen = new Set<string>();
    for (let skip = 0; skip < 1000; skip += 100) {
      const url = new URL(
        Client.serverApiUrl(context, "policy/evaluations", {
          artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${input.number}`,
          includeNotApplicable: true,
          $top: 100,
          $skip: skip,
        }),
      );
      url.searchParams.set("api-version", "7.0-preview.1");
      const page = yield* read(
        input.cwd,
        url.href,
        Schema.Struct({ value: Schema.Array(Checks.Policy), count: Schema.optional(Schema.Int) }),
      );
      if (page.count !== undefined && page.count !== page.value.length)
        return yield* failure("checks", "Azure DevOps Server returned an incomplete policy page.");
      for (const policy of page.value) {
        if (seen.has(policy.evaluationId))
          return yield* failure(
            "checks",
            "Azure DevOps Server repeated a policy page; check coverage is incomplete.",
          );
        seen.add(policy.evaluationId);
        policies.push(policy);
      }
      if (page.value.length < 100)
        return Checks.checks(statuses.value, policies, latest, context, input.number);
    }
    return yield* failure(
      "checks",
      "Azure DevOps Server policy retrieval exceeded its page limit.",
    );
  });
  const changes = Effect.fn("AzureDevOpsServerPullRequestProvider.changes")(function* (
    input: Request,
    context: Client.AzureDevOpsServerContext,
    iteration: Json.Iteration,
  ) {
    const entries: Json.Change[] = [];
    let skip = 0;
    for (;;) {
      const page = yield* read(
        input.cwd,
        Client.serverApiUrl(
          context,
          `${prPath(context, input.number)}/iterations/${iteration.id}/changes`,
          {
            $compareTo: 0,
            $top: Math.min(2000, 10_000 - skip),
            $skip: skip,
          },
        ),
        Changes,
      );
      entries.push(
        ...page.changeEntries.filter(
          (entry) =>
            !entry.item.isFolder && (entry.item.gitObjectType ?? "blob").toLowerCase() === "blob",
        ),
      );
      const next = page.nextSkip ?? 0;
      if (next === 0) return { entries, truncated: false };
      if (!Number.isSafeInteger(next) || next <= skip || next >= 10_000)
        return { entries, truncated: true };
      skip = next;
    }
  });
  const texts = (
    input: Request,
    context: Client.AzureDevOpsServerContext,
    iteration: Json.Iteration,
    change: Pick<AzureDevOpsChangeEntry, "path" | "oldPath" | "changeKind">,
  ) => {
    const item = (path: string, commit: string) =>
      fileReads.withPermits(1)(
        read(
          input.cwd,
          Client.serverApiUrl(context, `git/repositories/${encode(context.repository)}/items`, {
            path: `/${path}`,
            includeContent: true,
            includeContentMetadata: true,
            "versionDescriptor.version": commit,
            "versionDescriptor.versionType": "commit",
          }),
          Item,
        ),
      );
    const empty = { content: "", contentMetadata: { isBinary: false } };
    return Effect.all(
      [
        change.changeKind === "new"
          ? Effect.succeed(empty)
          : item(change.oldPath, iteration.commonRefCommit.commitId),
        change.changeKind === "deleted"
          ? Effect.succeed(empty)
          : item(change.path, iteration.sourceRefCommit.commitId),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([old, current]) => ({
        oldContents: old.content ?? "",
        newContents: current.content ?? "",
        binary:
          old.contentMetadata?.isBinary === true || current.contentMetadata?.isBinary === true,
      })),
    );
  };
  const threadId = (value: string) =>
    /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const readThread = (input: Request, context: Client.AzureDevOpsServerContext, id: string) => {
    if (!threadId(id))
      return Effect.fail(failure("thread", "The Azure discussion thread id is invalid."));
    return read(
      input.cwd,
      Client.serverApiUrl(context, `${prPath(context, input.number)}/threads/${id}`),
      Json.Thread,
    ).pipe(
      Effect.filterOrFail(
        (thread) => !thread.isDeleted && String(thread.id) === id,
        () => failure("thread", "This discussion thread is no longer available."),
      ),
    );
  };
  const unsupported = (operation: string) =>
    Effect.fail(
      failure(operation, "This action is not supported by this Azure DevOps Server integration."),
    );

  const viewedScope = Effect.fn("AzureDevOpsServerPullRequestProvider.viewedScope")(function* (
    input: Request,
  ) {
    const { context, raw } = yield* readPr(input);
    const projectId = raw.repository.project?.id;
    if (!projectId)
      return yield* failure(
        "filesViewed",
        "Azure DevOps Server omitted the project identity needed for native viewed-file tracking.",
      );
    const iteration = (yield* iterations(input, context)).at(-1);
    const listed = iteration
      ? yield* changes(input, context, iteration)
      : { entries: [], truncated: false };
    const url = `${context.collectionUrl}/_apis/Contribution/HierarchyQuery/project/${encode(projectId)}?api-version=7.0-preview.1`;
    const query = (modifications: Readonly<Record<string, unknown>> = {}) =>
      request({
        cwd: input.cwd,
        url,
        method: "POST",
        body: {
          contributionIds: [Viewed.VIEWED_PROVIDER_ID],
          dataProviderContext: {
            properties: {
              repositoryId: raw.repository.id,
              pullRequestId: input.number,
              ...modifications,
            },
          },
        },
      }).pipe(
        Effect.flatMap((data) => decode(Viewed.ViewedResponse, data)),
        Effect.filterOrFail(
          (data) =>
            Object.keys(data.dataProviderExceptions ?? {}).length === 0 &&
            Object.keys(data.exceptions ?? {}).length === 0,
          () =>
            failure(
              "filesViewed",
              "Azure DevOps Server could not supply its native viewed-file state.",
            ),
        ),
      );
    const hashes = () =>
      query().pipe(
        Effect.flatMap((data) => {
          const state = data.dataProviders[Viewed.VIEWED_PROVIDER_ID].visit.viewedState;
          return state === null || state === ""
            ? Effect.succeed({} as Readonly<Record<string, 2>>)
            : decode(Viewed.ViewedStateJson, state).pipe(Effect.map((value) => value.hashes));
        }),
      );
    return { context, raw, projectId, listed, query, hashes };
  });

  const inViewedOrder = (
    input: Request,
    operation: Effect.Effect<void, PullRequestProviderError>,
  ) =>
    Effect.suspend(() => {
      const key = [input.host.toLowerCase(), input.repository.toLowerCase(), input.number].join(
        "\0",
      );
      const entry = viewedWrites.get(key) ?? { gate: Semaphore.makeUnsafe(1), pending: 0 };
      viewedWrites.set(key, entry);
      entry.pending += 1;
      return entry.gate
        .withPermits(1)(operation)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.pending -= 1;
              if (entry.pending === 0) viewedWrites.delete(key);
            }),
          ),
        );
    });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    repositoryKey: ({ canonicalKey }) => canonicalKey,
    getViewer: (input) =>
      resolve(input).pipe(Effect.flatMap((context) => viewer(input.cwd, context))),
    listChangeRequests: Effect.fn("AzureDevOpsServerPullRequestProvider.listChangeRequests")(
      function* (input) {
        const context = yield* resolve(input);
        const top = Math.min(input.limit, 100);
        const state =
          input.state === "open"
            ? "active"
            : input.state === "closed"
              ? "abandoned"
              : input.state === "merged"
                ? "completed"
                : "all";
        const data = yield* read(
          input.cwd,
          Client.serverApiUrl(
            context,
            `git/repositories/${encode(context.repository)}/pullRequests`,
            {
              "searchCriteria.status": state,
              $top: top,
              $skip: input.cursor?.delivered ?? 0,
              ...(input.involvement === "authored"
                ? { "searchCriteria.creatorId": input.viewer }
                : {}),
              ...(input.involvement === "reviewing"
                ? { "searchCriteria.reviewerId": input.viewer }
                : {}),
            },
          ),
          Schema.Struct({ value: Schema.Array(Json.PullRequest) }),
        );
        return {
          items: data.value.map((raw) => Json.changeRequest(raw, context)),
          truncated: data.value.length >= top,
          cursorAdvance: data.value.length,
          continues: true,
        };
      },
    ),
    getChangeRequestSummary: (input) =>
      readPr(input).pipe(Effect.map(({ context, raw }) => Json.changeRequest(raw, context))),
    getChangeRequestWatchFingerprint: Effect.fn(
      "AzureDevOpsServerPullRequestProvider.getChangeRequestWatchFingerprint",
    )(function* (input) {
      const { context, raw } = yield* readPr(input);
      if (raw.status !== "active") return { status: raw.status, remarks: "" };
      const latest = (yield* iterations(input, context)).at(-1);
      const [results, discussion] = yield* Effect.all(
        [
          Effect.matchEffect(checks(input, context, raw, latest), {
            onFailure: (error) =>
              error.reason === "rate-limited" ? Effect.fail(error) : Effect.succeed(null),
            onSuccess: Effect.succeed,
          }),
          threads(input, context),
        ],
        { concurrency: 2 },
      );
      const activity = Json.discussion(discussion, "");
      const remarks = [
        ...activity.comments,
        ...activity.reviewThreads.flatMap((thread) => thread.comments),
      ];
      return {
        status: fingerprint([
          raw.status,
          raw.isDraft,
          raw.mergeStatus,
          raw.lastMergeSourceCommit,
          latest?.sourceRefCommit,
          results,
          (raw.reviewers ?? []).map((reviewer) => [reviewer.id, reviewer.vote]).toSorted(),
        ]),
        remarks: fingerprint(
          remarks
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .map((remark) => [remark.id, remark.createdAt, remark.editedAt]),
        ),
      };
    }),
    getChangeRequest: Effect.fn("AzureDevOpsServerPullRequestProvider.getChangeRequest")(
      function* (input) {
        const { context, raw } = yield* readPr(input);
        const latest = (yield* iterations(input, context)).at(-1);
        const listed =
          latest === undefined ? { entries: [] } : yield* changes(input, context, latest);
        const results = yield* checks(input, context, raw, latest).pipe(
          Effect.catchTags({
            PullRequestProviderError: (error) =>
              Effect.logDebug("Azure DevOps Server checks unavailable", {
                reason: error.reason,
              }).pipe(Effect.as(null)),
          }),
        );
        return {
          ...Json.changeRequest(raw, context),
          body: raw.description ?? "",
          ...(latest ? { headSha: latest.sourceRefCommit.commitId } : {}),
          changedFiles: listed.entries.length,
          closedAt: raw.status === "abandoned" ? (raw.closedDate ?? null) : null,
          mergedAt: raw.status === "completed" ? (raw.closedDate ?? null) : null,
          reviewers: (raw.reviewers ?? []).map(Json.actor),
          checks: results ?? [],
          checksIncomplete: results === null,
          mergeCapabilities: { merge: true, squash: true, rebase: false },
          viewerPermissions: PERMISSIONS,
          autoMergeEnabled: raw.autoCompleteSetBy != null,
          ...(raw.autoCompleteSetBy
            ? {
                autoMergeMethod:
                  raw.completionOptions?.mergeStrategy === "squash" ||
                  raw.completionOptions?.squashMerge
                    ? ("squash" as const)
                    : ("merge" as const),
              }
            : {}),
        };
      },
    ),
    getChangeRequestActivity: Effect.fn(
      "AzureDevOpsServerPullRequestProvider.getChangeRequestActivity",
    )(function* (input) {
      const { context, raw } = yield* readPr(input);
      const id = yield* viewer(input.cwd, context);
      const data = yield* threads(input, context);
      return {
        ...Json.discussion(data, id),
        reviewers: (raw.reviewers ?? []).map(Json.actor),
      };
    }),
    getViewerPermissions: () => Effect.succeed(PERMISSIONS),
    getDiff: Effect.fn("AzureDevOpsServerPullRequestProvider.getDiff")(function* (input) {
      const context = yield* resolve(input);
      const cursor = parseAzureDevOpsDiffCursor(input.cursor);
      const all = yield* iterations(input, context);
      const iteration =
        cursor === null ? all.at(-1) : all.find((entry) => entry.id === cursor.iterationId);
      if (iteration === undefined) return { patch: "", truncated: false, nextCursor: null };
      const listed = yield* changes(input, context, iteration);
      const entries = listed.entries.map(Json.changeEntry);
      const sections: string[] = [];
      let index = cursor?.fileIndex ?? 0;
      let bytes = 0;
      let edits = 0;
      let truncated = listed.truncated;
      while (index < entries.length && sections.length < MAX_DIFF_SLICE_FILES) {
        const batch = entries.slice(
          index,
          index + Math.min(4, MAX_DIFF_SLICE_FILES - sections.length),
        );
        const patches = yield* Effect.forEach(
          batch,
          (change) =>
            texts(input, context, iteration, change).pipe(
              Effect.map((contents) => azureDevOpsFilePatch({ change, texts: contents })),
              Effect.catchIf(
                (error) => error.reason === "not-found",
                () => Effect.succeed(azureDevOpsUnreadableFilePatch(change)),
              ),
            ),
          { concurrency: 4 },
        );
        for (const patch of patches) {
          sections.push(patch.section);
          index += 1;
          bytes += byteLength(patch.section);
          edits += patch.edits;
          truncated ||= patch.truncated;
          if (
            bytes >= MAX_DIFF_SLICE_BYTES ||
            edits + MAX_FILE_DIFF_EDITS > MAX_DIFF_SLICE_EDITS ||
            patch.abandoned
          )
            break;
        }
        if (
          bytes >= MAX_DIFF_SLICE_BYTES ||
          edits + MAX_FILE_DIFF_EDITS > MAX_DIFF_SLICE_EDITS ||
          patches.some((patch) => patch.abandoned)
        )
          break;
        yield* Effect.yieldNow;
      }
      const slice: ProviderDiffSlice = {
        patch: sections.join(""),
        truncated,
        baseSha: iteration.commonRefCommit.commitId,
        headSha: iteration.sourceRefCommit.commitId,
        nextCursor:
          index >= entries.length
            ? null
            : formatAzureDevOpsDiffCursor({ iterationId: iteration.id, fileIndex: index }),
      };
      return slice;
    }),
    getDiffFileContents: Effect.fn("AzureDevOpsServerPullRequestProvider.getDiffFileContents")(
      function* (input) {
        const context = yield* resolve(input);
        const iteration = (yield* iterations(input, context)).at(-1);
        if (!iteration) return { oldContents: "", newContents: "" };
        return yield* texts(input, context, iteration, {
          changeKind: input.changeType,
          path: input.newPath,
          oldPath: input.oldPath,
        });
      },
    ),
    getFilesViewed: Effect.fn("AzureDevOpsServerPullRequestProvider.getFilesViewed")(
      function* (input) {
        const scope = yield* viewedScope(input);
        return Viewed.viewedFiles(
          scope.listed.entries,
          yield* scope.hashes(),
          scope.listed.truncated,
        );
      },
    ),
    setFilesViewed: (input) =>
      input.files.length === 0
        ? Effect.void
        : inViewedOrder(
            input,
            Effect.gen(function* () {
              const scope = yield* viewedScope(input);
              const requested = new Map(input.files.map((file) => [file.path, file.viewed]));
              const candidates = new Map<string, Json.Change | null>();
              for (const entry of scope.listed.entries) {
                const path = entry.item.path.slice(1);
                candidates.set(path, candidates.has(path) ? null : entry);
              }
              const prepared: Array<{
                readonly path: string;
                readonly token: string;
                readonly viewed: boolean;
              }> = [];
              for (const [path, viewed] of requested) {
                const change = candidates.get(path);
                const token = change ? Viewed.viewedToken(change) : null;
                if (!token)
                  return yield* failure(
                    "setFilesViewed",
                    "Native viewed-file tracking is unavailable for a requested file. Refresh the PR; no viewed marks were changed.",
                  );
                prepared.push({ path: `/${path}`, token, viewed });
              }
              const before = yield* scope.hashes();
              const mark = prepared.filter((file) => file.viewed).map((file) => file.token);
              const unmark = [
                ...new Set(
                  prepared
                    .filter((file) => !file.viewed)
                    .flatMap((file) => Viewed.unviewTokens(file.path, file.token, before)),
                ),
              ];
              const update = (tokens: ReadonlyArray<string>, status: 1 | 2) =>
                scope.query({
                  projectId: scope.projectId,
                  modifyHashes: tokens,
                  modifyViewedStatus: status,
                  sourcePage: {
                    url: `${scope.context.repositoryUrl}/pullrequest/${input.number}?_a=files`,
                    routeId: "ms.vss-code-web.pull-request-details-route",
                    routeValues: {
                      project: scope.context.project,
                      GitRepositoryName: scope.raw.repository.name,
                      parameters: String(input.number),
                      vctype: "git",
                      controller: "ContributedPage",
                      action: "Execute",
                    },
                  },
                });
              let updated = false;
              yield* Effect.gen(function* () {
                if (mark.length) {
                  yield* update(mark, 2);
                  updated = true;
                }
                if (unmark.length) {
                  yield* update(unmark, 1);
                  updated = true;
                }
                // The Contribution write response can contain the old state even after a successful update.
                const after = yield* scope.hashes();
                if (
                  mark.some((token) => after[token] !== 2) ||
                  unmark.some((token) => after[token] === 2)
                ) {
                  return yield* failure(
                    "setFilesViewed",
                    "Azure DevOps Server did not confirm the requested viewed-file state.",
                  );
                }
              }).pipe(
                Effect.mapError((cause) => {
                  if (
                    !updated &&
                    isServerError(cause.cause) &&
                    (cause.cause.outcome === "not-sent" || cause.cause.outcome === "rejected")
                  )
                    return cause;
                  return new PullRequestProviderError({
                    provider: KIND,
                    operation: "setFilesViewed",
                    reason: cause.reason,
                    detail:
                      "The native viewed-file update could not be fully confirmed. Some marks may have changed; refresh the PR before retrying. No requests were replayed.",
                    cause,
                  });
                }),
              );
            }),
          ),
    runAction: Effect.fn("AzureDevOpsServerPullRequestProvider.runAction")(function* (input) {
      const { context, raw } = yield* readPr(input);
      let body: unknown;
      switch (input.action) {
        case "merge":
          if (!raw.lastMergeSourceCommit)
            return yield* failure("merge", "The pull request has no source commit to complete.");
          body = {
            status: "completed",
            lastMergeSourceCommit: raw.lastMergeSourceCommit,
            completionOptions: {
              mergeStrategy: input.mergeMethod === "squash" ? "squash" : "noFastForward",
              bypassPolicy: false,
            },
          };
          break;
        case "enable-auto-merge":
          body = {
            autoCompleteSetBy: { id: yield* viewer(input.cwd, context) },
            completionOptions: {
              mergeStrategy: input.mergeMethod === "squash" ? "squash" : "noFastForward",
              bypassPolicy: false,
            },
          };
          break;
        case "disable-auto-merge":
          body = { autoCompleteSetBy: null };
          break;
        case "draft":
          body = { isDraft: true };
          break;
        case "ready":
          body = { isDraft: false };
          break;
        case "close":
          body = { status: "abandoned" };
          break;
        case "reopen":
          body = { status: "active" };
          break;
        default:
          return yield* unsupported("runAction");
      }
      yield* write(
        input.cwd,
        Client.serverApiUrl(context, prPath(context, input.number)),
        "PATCH",
        body,
      );
    }),
    updateChangeRequest: Effect.fn("AzureDevOpsServerPullRequestProvider.updateChangeRequest")(
      function* (input) {
        const { context } = yield* readPr(input);
        yield* write(
          input.cwd,
          Client.serverApiUrl(context, prPath(context, input.number)),
          "PATCH",
          {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { description: input.body }),
          },
        );
      },
    ),
    comment: Effect.fn("AzureDevOpsServerPullRequestProvider.comment")(function* (input) {
      const { context } = yield* readPr(input);
      yield* write(
        input.cwd,
        Client.serverApiUrl(context, `${prPath(context, input.number)}/threads`),
        "POST",
        {
          comments: [{ content: input.body, parentCommentId: 0, commentType: 1 }],
          status: 1,
        },
      );
    }),
    updateComment: Effect.fn("AzureDevOpsServerPullRequestProvider.updateComment")(
      function* (input) {
        const { context } = yield* readPr(input);
        const [tid, cid, ...extra] = input.commentId.split(":");
        if (!tid || !cid || extra.length || !threadId(cid))
          return yield* failure("updateComment", "The Azure comment id is invalid.");
        const thread = yield* readThread(input, context, tid);
        const comment = thread.comments?.find(
          (entry) => String(entry.id) === cid && !entry.isDeleted,
        );
        const id = yield* viewer(input.cwd, context);
        if (!comment || comment.author.id !== id)
          return yield* failure("updateComment", "Only your own available comments can be edited.");
        yield* write(
          input.cwd,
          Client.serverApiUrl(
            context,
            `${prPath(context, input.number)}/threads/${tid}/comments/${cid}`,
          ),
          "PATCH",
          { content: input.body },
        );
      },
    ),
    replyToThread: Effect.fn("AzureDevOpsServerPullRequestProvider.replyToThread")(
      function* (input) {
        const { context } = yield* readPr(input);
        const thread = yield* readThread(input, context, input.threadId);
        const parent = thread.comments?.find(
          (comment) =>
            !comment.isDeleted && comment.commentType !== "system" && comment.commentType !== 3,
        );
        if (!parent)
          return yield* failure(
            "replyToThread",
            "This discussion has no available comment to reply to.",
          );
        yield* write(
          input.cwd,
          Client.serverApiUrl(
            context,
            `${prPath(context, input.number)}/threads/${thread.id}/comments`,
          ),
          "POST",
          {
            content: input.body,
            parentCommentId: parent.id,
            commentType: 1,
          },
        );
      },
    ),
    setThreadResolution: Effect.fn("AzureDevOpsServerPullRequestProvider.setThreadResolution")(
      function* (input) {
        const { context } = yield* readPr(input);
        const thread = yield* readThread(input, context, input.threadId);
        yield* write(
          input.cwd,
          Client.serverApiUrl(context, `${prPath(context, input.number)}/threads/${thread.id}`),
          "PATCH",
          { status: input.resolved ? "fixed" : "active" },
        );
      },
    ),
    setReaction: Effect.fn("AzureDevOpsServerPullRequestProvider.setReaction")(function* (input) {
      if (input.content !== "thumbs-up" || !input.subjectId)
        return yield* failure(
          "setReaction",
          "Azure DevOps Server supports thumbs-up likes on comments only.",
        );
      const { context } = yield* readPr(input);
      const [tid, cid, ...extra] = input.subjectId.split(":");
      if (!tid || !cid || extra.length || !threadId(cid))
        return yield* failure("setReaction", "The Azure comment id is invalid.");
      const thread = yield* readThread(input, context, tid);
      if (!thread.comments?.some((comment) => String(comment.id) === cid && !comment.isDeleted))
        return yield* failure("setReaction", "This comment is no longer available.");
      yield* write(
        input.cwd,
        Client.serverApiUrl(
          context,
          `${prPath(context, input.number)}/threads/${tid}/comments/${cid}/likes`,
        ),
        input.reacted ? "POST" : "DELETE",
      );
    }),
    submitReview: Effect.fn("AzureDevOpsServerPullRequestProvider.submitReview")(function* (input) {
      const { context } = yield* readPr(input);
      const id = yield* viewer(input.cwd, context);
      const latest =
        input.comments.length === 0 ? undefined : (yield* iterations(input, context)).at(-1);
      const listed = latest ? yield* changes(input, context, latest) : undefined;
      const bodies: unknown[] = [];
      for (const comment of input.comments) {
        if (
          !latest ||
          !comment.headSha ||
          !comment.baseSha ||
          comment.headSha !== latest.sourceRefCommit.commitId ||
          comment.baseSha !== latest.commonRefCommit.commitId
        ) {
          return yield* failure(
            "submitReview",
            "The pull request changed or the draft has no diff snapshot. Refresh and re-check your inline comments before submitting.",
          );
        }
        const position = comment.position;
        const left =
          position.kind === "deleted" || (position.kind === "context" && position.side === "left");
        const matches = listed?.entries.filter(
          (entry) =>
            entry.item.path.replace(/^\//, "") === comment.path ||
            (left &&
              (entry.sourceServerItem ?? entry.originalPath)?.replace(/^\//, "") === comment.path),
        );
        const change = matches?.length === 1 ? matches[0] : undefined;
        if (!change?.changeTrackingId)
          return yield* failure(
            "submitReview",
            "An inline comment no longer matches a tracked file in this diff. Refresh and re-check it before submitting.",
          );
        const line =
          position.kind === "deleted"
            ? position.oldLine
            : position.kind === "added"
              ? position.newLine
              : left
                ? position.oldLine
                : position.newLine;
        const point = { line, offset: 1 };
        bodies.push({
          comments: [{ content: comment.body, parentCommentId: 0, commentType: 1 }],
          status: 1,
          threadContext: {
            filePath: change.item.path,
            ...(left
              ? { leftFileStart: point, leftFileEnd: point }
              : { rightFileStart: point, rightFileEnd: point }),
          },
          pullRequestThreadContext: {
            changeTrackingId: change.changeTrackingId,
            iterationContext: {
              firstComparingIteration: latest.id,
              secondComparingIteration: latest.id,
            },
          },
        });
      }
      let summaryPosted = false;
      const postedCommentIndexes: number[] = [];
      const send = Effect.gen(function* () {
        if (input.body.trim()) {
          yield* write(
            input.cwd,
            Client.serverApiUrl(context, `${prPath(context, input.number)}/threads`),
            "POST",
            {
              comments: [{ content: input.body, parentCommentId: 0, commentType: 1 }],
              status: 1,
            },
          );
          summaryPosted = true;
        }
        for (const [index, body] of bodies.entries()) {
          yield* write(
            input.cwd,
            Client.serverApiUrl(context, `${prPath(context, input.number)}/threads`),
            "POST",
            body,
          );
          postedCommentIndexes.push(index);
        }
        if (input.verdict !== "comment") {
          yield* write(
            input.cwd,
            Client.serverApiUrl(
              context,
              `${prPath(context, input.number)}/reviewers/${encode(id)}`,
            ),
            "PUT",
            {
              vote: input.verdict === "approve" ? 10 : -5,
            },
          );
        }
      });
      return yield* send.pipe(
        Effect.catch((error) => {
          const outcomeUnknown = isServerError(error.cause) && error.cause.outcome === "unknown";
          if (!summaryPosted && postedCommentIndexes.length === 0 && !outcomeUnknown)
            return Effect.fail(error);
          const result: PullRequestSubmitReviewPartialResult = {
            status: "partial",
            summaryPosted,
            postedCommentIndexes,
            outcomeUnknown,
            message: outcomeUnknown
              ? "Some review writes may have succeeded. Refresh and check the PR before deliberately retrying; the request was not replayed."
              : "The review was only partly submitted. Posted comments were retained; retry only the remaining comments and vote.",
          };
          return Effect.succeed(result);
        }),
      );
    }),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
  };
  return provider;
});
