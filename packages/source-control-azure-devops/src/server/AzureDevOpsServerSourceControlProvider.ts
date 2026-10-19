import {
  SourceControlProviderError,
  SourceControlProviderKind,
  PositiveInt,
  TrimmedNonEmptyString,
  type ChangeRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  providerAuth,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as Client from "./AzureDevOpsServerClient.ts";

const kind = SourceControlProviderKind.make("azure-devops-custom-server");
const PullRequest = Schema.Struct({
  pullRequestId: PositiveInt,
  title: TrimmedNonEmptyString,
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  status: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  forkSource: Schema.optional(Schema.NullOr(Schema.Unknown)),
  _links: Schema.optional(
    Schema.Struct({ web: Schema.optional(Schema.Struct({ href: Schema.String })) }),
  ),
});
const Repository = Schema.Struct({
  remoteUrl: Schema.String,
  sshUrl: Schema.optional(Schema.String),
  defaultBranch: Schema.optional(Schema.String),
});
const decodePullRequest = Schema.decodeUnknownEffect(PullRequest);
const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.Struct({ value: Schema.Array(PullRequest) }),
);
const decodeRepository = Schema.decodeUnknownEffect(Repository);
const isServerError = Schema.is(Client.AzureDevOpsServerError);

function remoteSelector(remoteUrl: string): URL {
  const url = new URL(remoteUrl);
  if (url.protocol !== "https:" || url.search || url.hash)
    throw new Error("Invalid repository remote");
  url.username = "";
  url.password = "";
  return url;
}

function changeRequest(
  raw: typeof PullRequest.Type,
  context: Client.AzureDevOpsServerContext,
): ChangeRequest {
  const state =
    raw.status === "completed" ? "merged" : raw.status === "abandoned" ? "closed" : "open";
  let url = `${context.repositoryUrl}/pullrequest/${raw.pullRequestId}`;
  try {
    const web = new URL(raw._links?.web?.href ?? url);
    if (
      web.origin === context.origin &&
      web.pathname.startsWith(`${new URL(context.collectionUrl).pathname}/`) &&
      !web.username &&
      !web.password &&
      !web.search &&
      !web.hash
    )
      url = web.href;
  } catch {}
  return {
    provider: kind,
    number: raw.pullRequestId,
    title: raw.title,
    url,
    baseRefName: raw.targetRefName.replace(/^refs\/heads\//, ""),
    headRefName: raw.sourceRefName.replace(/^refs\/heads\//, ""),
    state,
    ...(raw.isDraft !== undefined ? { isDraft: raw.isDraft } : {}),
    isCrossRepository: raw.forkSource != null,
    closedAt: raw.closedDate ?? null,
    mergedAt: state === "merged" ? (raw.closedDate ?? null) : null,
    updatedAt: Option.none(),
  };
}

function referenceNumber(reference: string, context: Client.AzureDevOpsServerContext): number {
  const number = /^#?(\d+)$/.exec(reference.trim())?.[1];
  if (number && Number.isSafeInteger(Number(number)) && Number(number) > 0) return Number(number);
  const url = new URL(reference);
  const expected = new URL(context.repositoryUrl);
  const match = /^\/pullrequest\/(\d+)\/?$/.exec(url.pathname.slice(expected.pathname.length));
  if (
    url.origin !== expected.origin ||
    !url.pathname.startsWith(`${expected.pathname}/`) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    Number(match[1]) <= 0 ||
    !Number.isSafeInteger(Number(match[1]))
  )
    throw new Error("Invalid pull request reference");
  return Number(match[1]);
}

export const make = Effect.gen(function* () {
  const client = yield* Client.AzureDevOpsServerClient;
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const mapError = (operation: string, cwd: string) => (cause: unknown) =>
    new SourceControlProviderError({
      provider: kind,
      operation,
      cwd,
      detail: isServerError(cause) ? cause.detail : "Azure DevOps Server operation failed.",
      cause,
    });
  const contextFor = Effect.fnUntraced(function* (input: {
    cwd: string;
    context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    if (!input.context) return yield* client.resolve({ cwd: input.cwd });
    const remote = yield* Effect.try({
      try: () => remoteSelector(input.context!.remoteUrl),
      catch: () =>
        new Client.AzureDevOpsServerError({
          operation: "resolve",
          reason: "failed",
          outcome: "not-sent",
        }),
    });
    return yield* client.resolve({
      cwd: input.cwd,
      host: input.context.requestedHost ?? remote.host,
      repository: remote.pathname.slice(1),
    });
  });
  const read = Effect.fnUntraced(function* (input: {
    cwd: string;
    context?: SourceControlProvider.SourceControlProviderContext;
    reference: string;
  }) {
    const context = yield* contextFor(input);
    const number = yield* Effect.try({
      try: () => referenceNumber(input.reference, context),
      catch: () =>
        new Client.AzureDevOpsServerError({
          operation: "reference",
          reason: "failed",
          outcome: "not-sent",
        }),
    });
    const raw = yield* client.request({
      cwd: input.cwd,
      url: Client.serverApiUrl(
        context,
        `git/repositories/${encodeURIComponent(context.repository)}/pullRequests/${number}`,
      ),
    });
    const pr = yield* decodePullRequest(raw);
    return { context, pr };
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    refineRepositoryIdentity: ({ identity }) => {
      if (
        !identity.rootPath ||
        (identity.provider !== undefined &&
          identity.provider !== "unknown" &&
          identity.provider !== kind)
      )
        return Effect.succeed(identity);
      return contextFor({
        cwd: identity.rootPath,
        context: {
          provider: { kind, name: "JDWeb Server (custom)", baseUrl: "" },
          remoteName: identity.locator.remoteName,
          remoteUrl: identity.locator.remoteUrl,
        },
      }).pipe(
        Effect.map((context) => ({ ...identity, provider: kind, webUrl: context.repositoryUrl })),
        Effect.orElseSucceed(() => identity),
      );
    },
    listChangeRequests: (input) =>
      Effect.gen(function* () {
        const context = yield* contextFor(input);
        const raw = yield* client.request({
          cwd: input.cwd,
          url: Client.serverApiUrl(
            context,
            `git/repositories/${encodeURIComponent(context.repository)}/pullRequests`,
            {
              "searchCriteria.status":
                input.state === "merged"
                  ? "completed"
                  : input.state === "closed"
                    ? "abandoned"
                    : input.state === "all"
                      ? "all"
                      : "active",
              "searchCriteria.sourceRefName": `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
              $top: input.limit ?? 100,
            },
          ),
        });
        const list = yield* decodePullRequests(raw);
        return list.value.map((pr) => changeRequest(pr, context));
      }).pipe(Effect.mapError(mapError("listChangeRequests", input.cwd))),
    getChangeRequest: (input) =>
      read(input).pipe(
        Effect.map(({ context, pr }) => changeRequest(pr, context)),
        Effect.mapError(mapError("getChangeRequest", input.cwd)),
      ),
    createChangeRequest: (input) =>
      Effect.gen(function* () {
        const context = yield* contextFor(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        if (source?.repository || source?.owner || input.target?.repository || input.target?.owner)
          return yield* new Client.AzureDevOpsServerError({
            operation: "createChangeRequest",
            reason: "failed",
            outcome: "not-sent",
          });
        const description = yield* fs.readFileString(input.bodyFile, "utf8");
        yield* client.request({
          cwd: input.cwd,
          method: "POST",
          url: Client.serverApiUrl(
            context,
            `git/repositories/${encodeURIComponent(context.repository)}/pullRequests`,
          ),
          body: {
            sourceRefName: `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
            targetRefName: `refs/heads/${input.baseRefName.replace(/^refs\/heads\//, "")}`,
            title: input.title,
            description,
          },
        });
      }).pipe(Effect.mapError(mapError("createChangeRequest", input.cwd))),
    getRepositoryCloneUrls: (input) =>
      Effect.gen(function* () {
        if (input.context) yield* contextFor(input);
        const context = yield* client.resolve({
          cwd: input.cwd,
          repository: input.repository,
          ...(input.context?.requestedHost ? { host: input.context.requestedHost } : {}),
        });
        const raw = yield* client.request({
          cwd: input.cwd,
          url: Client.serverApiUrl(
            context,
            `git/repositories/${encodeURIComponent(context.repository)}`,
          ),
        });
        const repository = yield* decodeRepository(raw);
        return {
          nameWithOwner: context.repositoryPath,
          url: repository.remoteUrl,
          sshUrl: repository.sshUrl ?? context.repositoryUrl,
        };
      }).pipe(Effect.mapError(mapError("getRepositoryCloneUrls", input.cwd))),
    createRepository: (input) =>
      Effect.fail(
        new SourceControlProviderError({
          provider: kind,
          operation: "createRepository",
          cwd: input.cwd,
          detail: "Publishing repositories to Azure DevOps Server is not supported.",
        }),
      ),
    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        const context = yield* contextFor(input);
        const raw = yield* client.request({
          cwd: input.cwd,
          url: Client.serverApiUrl(
            context,
            `git/repositories/${encodeURIComponent(context.repository)}`,
          ),
        });
        const repository = yield* decodeRepository(raw);
        return repository.defaultBranch?.replace(/^refs\/heads\//, "") ?? null;
      }).pipe(Effect.mapError(mapError("getDefaultBranch", input.cwd))),
    checkoutChangeRequest: (input) =>
      Effect.gen(function* () {
        const { context, pr } = yield* read(input);
        if (pr.forkSource != null)
          return yield* new Client.AzureDevOpsServerError({
            operation: "checkout",
            reason: "failed",
            outcome: "not-sent",
          });
        const remoteName =
          input.context?.remoteName ??
          (yield* host.git.ensureRemote({
            cwd: input.cwd,
            preferredName: "origin",
            url: context.repositoryUrl,
          }));
        const branch = pr.sourceRefName.replace(/^refs\/heads\//, "");
        yield* host.git.fetchRemoteTrackingBranch({
          cwd: input.cwd,
          remoteName,
          remoteBranch: branch,
        });
        const local = yield* host.git.listLocalBranchNames(input.cwd);
        yield* host.git.execute({
          operation: "checkoutChangeRequest",
          cwd: input.cwd,
          args: local.includes(branch)
            ? ["switch", ...(input.force ? ["--discard-changes"] : []), "--", branch]
            : ["switch", "--create", branch, "--track", `${remoteName}/${branch}`],
        });
      }).pipe(Effect.mapError(mapError("checkoutChangeRequest", input.cwd))),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const client = yield* Client.AzureDevOpsServerClient;
  const host = yield* SourceControlHost.SourceControlHost;
  const spec: SourceControlManagedCliDiscoverySpec = {
    type: "managed-cli",
    kind,
    label: "JDWeb Server (custom)",
    installHint: "Configure the collection URL and authentication in Settings → Source Control.",
    probe: (cwd) =>
      Effect.gen(function* () {
        const settings = yield* host.settings.get;
        const raw = settings.sourceControlHosts["azure-devops-custom-server"]?.collectionUrl;
        if (typeof raw !== "string" || !raw)
          return {
            kind,
            label: "JDWeb Server (custom)",
            executable: "curl",
            status: "available" as const,
            version: Option.none(),
            installHint: spec.installHint,
            detail: Option.none(),
            auth: providerAuth({ status: "unauthenticated", detail: spec.installHint }),
          };
        const result = yield* client
          .request({
            cwd,
            url: `${raw.replace(/\/+$/, "")}/_apis/connectionData?api-version=7.0-preview.1`,
          })
          .pipe(Effect.result);
        const configuredHost = yield* Effect.try({
          try: () => new URL(raw).host,
          catch: () =>
            new Client.AzureDevOpsServerError({
              operation: "settings",
              reason: "failed",
              outcome: "not-sent",
            }),
        });
        return {
          kind,
          label: "JDWeb Server (custom)",
          executable: "curl",
          status:
            result._tag === "Failure" && result.failure.reason === "missing-tool"
              ? ("missing" as const)
              : ("available" as const),
          version: Option.none(),
          installHint: spec.installHint,
          detail: Option.none(),
          auth: providerAuth({
            status:
              result._tag === "Success"
                ? "authenticated"
                : result.failure.reason === "unauthenticated"
                  ? "unauthenticated"
                  : "unknown",
            host: configuredHost,
          }),
        };
      }).pipe(
        Effect.orElseSucceed(() => ({
          kind,
          label: "JDWeb Server (custom)",
          executable: "curl",
          status: "available" as const,
          version: Option.none(),
          installHint: spec.installHint,
          detail: Option.none(),
          auth: providerAuth({ status: "unknown" }),
        })),
      ),
    refineUnknownRemote: ({ cwd, context }) =>
      Effect.try({
        try: () => remoteSelector(context.remoteUrl),
        catch: () =>
          new Client.AzureDevOpsServerError({
            operation: "resolve",
            reason: "failed",
            outcome: "not-sent",
          }),
      }).pipe(
        Effect.flatMap((remote) =>
          client.resolve({
            cwd,
            repository: remote.pathname.slice(1),
            host: context.requestedHost ?? remote.host,
          }),
        ),
        Effect.map((resolved) => ({
          kind,
          name: "JDWeb Server (custom)",
          baseUrl: resolved.collectionUrl,
        })),
        Effect.orElseSucceed(() => null),
      ),
  };
  return spec;
});
