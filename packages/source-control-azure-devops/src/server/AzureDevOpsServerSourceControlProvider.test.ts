import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Client from "./AzureDevOpsServerClient.ts";
import * as Provider from "./AzureDevOpsServerSourceControlProvider.ts";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";

const context: Client.AzureDevOpsServerContext = {
  origin: "https://ado.example",
  collectionUrl: "https://ado.example/Collection",
  projectUrl: "https://ado.example/Collection/Project",
  project: "Project",
  repository: "Repo",
  repositoryPath: "Collection/Project/_git/Repo",
  repositoryUrl: "https://ado.example/Collection/Project/_git/Repo",
};
const pr = {
  pullRequestId: 42,
  title: "Change",
  sourceRefName: "refs/heads/topic",
  targetRefName: "refs/heads/main",
  status: "active",
};
function provider(request: Client.AzureDevOpsServerClient["Service"]["request"]) {
  return Provider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Client.AzureDevOpsServerClient, {
          resolve: () => Effect.succeed(context),
          request,
        }),
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.succeed("Unicode description: café"),
          }),
        ),
        TestHost.layer(),
      ),
    ),
  );
}

it.effect.each([
  "ssh://ado.example:22/Collection/Project/_git/Repo",
  "git@ado.example:Collection/Project/_git/Repo",
])("discovers and reads PRs from a stored unknown SSH checkout: %s", (remoteUrl) => {
  let requests = 0;
  return Effect.gen(function* () {
    const client = yield* Client.make;
    const { service, discovery } = yield* Effect.all({
      service: Provider.make,
      discovery: Provider.makeDiscovery,
    }).pipe(Effect.provideService(Client.AzureDevOpsServerClient, client));
    const checkout = {
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("unknown"),
          name: "ado.example",
          baseUrl: "https://ado.example",
        },
        remoteName: "origin",
        remoteUrl,
      },
    };
    const result = yield* discovery.refineUnknownRemote(checkout);
    assert.strictEqual(result?.kind, "azure-devops-custom-server");
    assert.strictEqual(result?.baseUrl, context.collectionUrl);
    for (const rejected of [
      { remoteUrl: "ssh://elsewhere.example:22/Collection/Project/_git/Repo" },
      { remoteUrl: "ssh://ado.example:22/Other/Project/_git/Repo" },
      { requestedHost: "elsewhere.example" },
    ]) {
      assert.strictEqual(
        yield* discovery.refineUnknownRemote({
          ...checkout,
          context: { ...checkout.context, ...rejected },
        }),
        null,
      );
    }
    assert.ok(service.refineRepositoryIdentity);
    const identity = yield* service.refineRepositoryIdentity({
      resolveContext: () => Effect.die("Unexpected registry lookup"),
      identity: {
        canonicalKey: "ado.example/collection/project/_git/repo",
        provider: SourceControlProviderKind.make("unknown"),
        rootPath: "/repo",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl },
      },
    });
    assert.strictEqual(identity.provider, "azure-devops-custom-server");
    assert.strictEqual(identity.webUrl, context.repositoryUrl);
    const pullRequest = yield* service.getChangeRequest({ ...checkout, reference: "42" });
    assert.strictEqual(pullRequest.url, `${context.repositoryUrl}/pullrequest/42`);
    assert.strictEqual(requests, 1);
  }).pipe(
    Effect.provide(
      TestHost.layer({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sourceControlHosts: {
            "azure-devops-custom-server": {
              collectionUrl: context.collectionUrl,
              authentication: "pat",
              personalAccessToken: "test-token",
            },
          },
        },
        git: { remotes: () => Effect.die("Explicit remote should not read the checkout") },
        process: {
          run: () => {
            requests++;
            return Effect.succeed(
              TestHost.processOutput(`${JSON.stringify(pr)}\nT3_HTTP_STATUS:200`),
            );
          },
        },
      }),
    ),
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, {}),
  );
});

it.effect("keeps on-premises PR URLs and rejects references outside the selected repository", () =>
  Effect.gen(function* () {
    let requests = 0;
    const service = yield* provider(() => {
      requests++;
      return Effect.succeed(pr);
    });
    const result = yield* service.getChangeRequest({ cwd: "/repo", reference: "42" });
    assert.strictEqual(result.provider, "azure-devops-custom-server");
    assert.strictEqual(result.url, `${context.repositoryUrl}/pullrequest/42`);
    yield* service
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://elsewhere.example/Collection/Project/_git/Repo/pullrequest/42",
      })
      .pipe(Effect.flip);
    assert.strictEqual(requests, 1);
  }),
);

it.effect(
  "creates from UTF-8 body contents without pushing and rejects cross-repository selectors",
  () =>
    Effect.gen(function* () {
      const requests: Parameters<Client.AzureDevOpsServerClient["Service"]["request"]>[0][] = [];
      const service = yield* provider((input) => {
        requests.push(input);
        return Effect.succeed(pr);
      });
      const input = {
        cwd: "/repo",
        title: "Change",
        bodyFile: "/body.md",
        headSelector: "topic",
        baseRefName: "main",
      };
      yield* service.createChangeRequest(input);
      assert.strictEqual(requests[0]!.method, "POST");
      assert.deepStrictEqual(requests[0]!.body, {
        sourceRefName: "refs/heads/topic",
        targetRefName: "refs/heads/main",
        title: "Change",
        description: "Unicode description: café",
      });
      yield* service
        .createChangeRequest({ ...input, headSelector: "other:topic" })
        .pipe(Effect.flip);
      assert.strictEqual(requests.length, 1);
      const unsupported = yield* service
        .createRepository({ cwd: "/repo", repository: "new", visibility: "private" })
        .pipe(Effect.flip);
      assert.ok(unsupported.detail.includes("not supported"));
    }),
);
