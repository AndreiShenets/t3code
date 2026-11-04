import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Option from "effect/Option";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Client from "./AzureDevOpsServerClient.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const base = "https://ado.example:8443/tfs/Collection";
const url = `${base}/Project/_apis/git/repositories/Repo?api-version=7.0`;
const pat = "test-secret-token";
const failure = <A>(effect: Effect.Effect<A, Client.AzureDevOpsServerError>) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: Effect.succeed,
      onSuccess: () => Effect.die("Expected request failure"),
    }),
  );
function fixture(
  legacyAuthentication: "auto" | "pat" = "pat",
  responses: ReadonlyArray<number> = [200],
  features = "SSPI SPNEGO SSL",
  platform: NodeJS.Platform = "win32",
  remoteUrl = `${base}/Project/_git/Repo`,
  token = pat,
) {
  const calls: SourceControlHost.SourceControlProcessInput[] = [];
  let index = 0;
  const host = TestHost.layer({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlHosts: {
        "azure-devops-custom-server": {
          collectionUrl: base,
          authentication: legacyAuthentication,
          personalAccessToken: token,
        },
      },
    },
    process: {
      run: (input) => {
        calls.push(input);
        return Effect.succeed(
          TestHost.processOutput(
            input.args.includes("--version")
              ? `Features: ${features}`
              : `{"ok":true}\nT3_HTTP_STATUS:${responses[index++] ?? 200}`,
          ),
        );
      },
    },
    git: {
      remotes: () =>
        Effect.succeed(
          Effect.succeed({
            remotes: [
              {
                name: "origin",
                url: remoteUrl,
                pushUrl: Option.none(),
                isPrimary: true,
              },
            ],
            freshness: {
              source: "live-local",
              observedAt: DateTime.nowUnsafe(),
              expiresAt: Option.none(),
            },
          }),
        ),
    },
  });
  return {
    calls,
    client: Client.make.pipe(
      Effect.provide(host),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, {
        SystemRoot: "C:\\Windows",
        PATH: "test-path",
        CURL_HOME: "unsafe",
        HTTPS_PROXY: "http://corporate-proxy.example:8080",
        CURL_CA_BUNDLE: "/company/ca.pem",
        AZURE_DEVOPS_PAT: pat,
        AZURE_DEVOPS_EXT_PAT: pat,
      }),
    ),
  };
}

it.effect(
  "uses a configured PAT before Windows credentials without probing curl capabilities",
  () =>
    Effect.gen(function* () {
      const f = fixture("auto");
      const client = yield* f.client;
      yield* client.request({ cwd: "/repo", url });
      assert.strictEqual(f.calls.length, 1);
      assert.ok(!f.calls[0]!.args.includes("--negotiate"));
      assert.ok(f.calls[0]!.stdin?.includes("Authorization: Basic"));
    }),
);

it.effect("never falls back to Windows credentials when a configured PAT is rejected", () =>
  Effect.gen(function* () {
    for (const method of ["GET", "PATCH"] as const) {
      const f = fixture("auto", [401, 200]);
      const client = yield* f.client;
      const error = yield* failure(client.request({ cwd: "/repo", url, method }));
      assert.strictEqual(error.reason, "unauthenticated");
      assert.include(error.detail, "Check the saved PAT");
      assert.notInclude(error.detail, "Integrated authentication is unavailable or rejected");
      assert.strictEqual(f.calls.length, 1);
      assert.ok(!f.calls[0]!.args.includes("--negotiate"));
    }
  }),
);

it.effect(
  "uses Windows credentials with no PAT even when a retired PAT-only setting is present",
  () =>
    Effect.gen(function* () {
      const f = fixture("pat", [200], "SSPI SPNEGO SSL", "win32", undefined, "");
      const client = yield* f.client;
      yield* client.request({ cwd: "/repo", url });
      assert.strictEqual(f.calls.length, 2);
      assert.ok(f.calls[1]!.args.includes("--negotiate"));
      assert.ok(f.calls[1]!.args.includes(":"));
      assert.ok(!f.calls[1]!.stdin?.includes("Authorization: Basic"));
    }),
);

it.effect("uses a saved PAT when system curl lacks integrated auth support", () =>
  Effect.gen(function* () {
    const f = fixture("auto", [200], "SSL");
    const client = yield* f.client;
    yield* client.request({ cwd: "/repo", url });
    const request = f.calls.at(-1)!;
    assert.ok(!request.args.includes("--negotiate"));
    assert.ok(request.stdin?.includes("Authorization: Basic"));
  }),
);

it.effect("reuses system curl capabilities across file reads", () =>
  Effect.gen(function* () {
    const f = fixture("auto", [200], "SSPI SPNEGO SSL", "win32", undefined, "");
    const client = yield* f.client;
    yield* client.request({ cwd: "/repo", url });
    yield* client.request({ cwd: "/repo", url });
    assert.strictEqual(f.calls.filter((call) => call.args.includes("--version")).length, 1);
  }),
);

it.effect("uses PATH curl with a saved PAT outside Windows, without probing integrated auth", () =>
  Effect.gen(function* () {
    for (const platform of ["linux", "darwin"] as const) {
      const f = fixture("auto", [200], "SSPI SPNEGO SSL", platform);
      const client = yield* f.client;
      yield* client.request({ cwd: "/repo", url });
      assert.strictEqual(f.calls.length, 1);
      assert.strictEqual(f.calls[0]!.command, "curl");
      assert.ok(f.calls[0]!.stdin?.includes("Authorization: Basic"));
    }
  }),
);

it.effect("requires a PAT outside Windows and when Windows curl lacks integrated auth", () =>
  Effect.gen(function* () {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const f = fixture("auto", [200], "SSL", platform, undefined, "");
      const client = yield* f.client;
      const error = yield* failure(client.request({ cwd: "/repo", url }));
      assert.strictEqual(error.reason, "unauthenticated");
      assert.ok(f.calls.every((call) => call.args.includes("--version")));
    }
  }),
);

it.effect("reads fresh credentials and collection scope for each request", () =>
  Effect.gen(function* () {
    const calls: SourceControlHost.SourceControlProcessInput[] = [];
    yield* Effect.gen(function* () {
      const client = yield* Client.make;
      const settings = yield* TestHost.TestSourceControlHostSettings;
      yield* client.request({ cwd: "/repo", url });
      yield* settings.update({
        sourceControlHosts: {
          "azure-devops-custom-server": {
            collectionUrl: base,
            authentication: "pat",
            personalAccessToken: "replacement",
          },
        },
      });
      yield* client.request({ cwd: "/repo", url });
      assert.ok(calls[1]!.stdin?.includes(Buffer.from(":replacement").toString("base64")));
      yield* settings.update({
        sourceControlHosts: {
          "azure-devops-custom-server": {
            collectionUrl: "https://other.example/Collection",
            authentication: "pat",
            personalAccessToken: "replacement",
          },
        },
      });
      yield* failure(client.request({ cwd: "/repo", url }));
      assert.strictEqual(calls.length, 2);
    }).pipe(
      Effect.provide(
        TestHost.layer({
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sourceControlHosts: {
              "azure-devops-custom-server": {
                collectionUrl: base,
                authentication: "pat",
                personalAccessToken: pat,
              },
            },
          },
          process: {
            run: (input) => {
              calls.push(input);
              return Effect.succeed(TestHost.processOutput("{}\nT3_HTTP_STATUS:200"));
            },
          },
        }),
      ),
    );
  }),
);

it.effect("never retries transport failures or malformed successful mutation responses", () =>
  Effect.gen(function* () {
    for (const response of [
      TestHost.processOutput("", { exitCode: ChildProcessSpawner.ExitCode(28), stderr: pat }),
      TestHost.processOutput("invalid-json\nT3_HTTP_STATUS:200"),
    ]) {
      let calls = 0;
      const client = yield* Client.make.pipe(
        Effect.provide(
          TestHost.layer({
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sourceControlHosts: {
                "azure-devops-custom-server": {
                  collectionUrl: base,
                  authentication: "pat",
                  personalAccessToken: pat,
                },
              },
            },
            process: {
              run: () => {
                calls++;
                return Effect.succeed(response);
              },
            },
          }),
        ),
      );
      const error = yield* failure(client.request({ cwd: "/repo", url, method: "POST", body: {} }));
      assert.strictEqual(error.outcome, "unknown");
      assert.strictEqual(calls, 1);
      assert.ok(!String(error).includes(pat));
      assert.strictEqual(error.cause, undefined);
    }
  }),
);

it.effect("keeps PAT in stdin, disables curl configuration and uses bounded subprocesses", () =>
  Effect.gen(function* () {
    const f = fixture();
    const client = yield* f.client;
    assert.deepStrictEqual(yield* client.request({ cwd: "/repo", url }), { ok: true });
    const call = f.calls[0]!;
    assert.strictEqual(call.args[0], "-q");
    assert.strictEqual(call.args.includes("--location"), false);
    assert.strictEqual(call.args.join(" ").includes(pat), false);
    assert.ok(call.stdin?.includes(Buffer.from(`:${pat}`).toString("base64")));
    assert.strictEqual(call.timeoutMs, 35_000);
    assert.strictEqual(call.maxOutputBytes, 8 * 1024 * 1024);
    assert.strictEqual(call.command, "C:\\Windows\\System32\\curl.exe");
    assert.strictEqual(call.env?.PATH, "test-path");
    assert.strictEqual(call.env?.HTTPS_PROXY, "http://corporate-proxy.example:8080");
    assert.strictEqual(call.env?.CURL_CA_BUNDLE, "/company/ca.pem");
    assert.strictEqual(call.env?.AZURE_DEVOPS_PAT, undefined);
    assert.strictEqual(call.env?.AZURE_DEVOPS_EXT_PAT, undefined);
    assert.strictEqual(call.env?.CURL_HOME, "unsafe");
  }),
);

it.effect("rejects scope changes before invoking curl", () =>
  Effect.gen(function* () {
    const f = fixture();
    const client = yield* f.client;
    for (const invalid of [
      "http://ado.example:8443/tfs/Collection/_apis/x",
      "https://elsewhere.example/tfs/Collection/_apis/x",
      "https://ado.example/tfs/Collection/_apis/x",
      `${base}Other/_apis/x`,
      `${base}/../Other/_apis/x`,
      `${base}/%2fOther`,
      `https://user:secret@ado.example:8443/tfs/Collection/_apis/x`,
    ]) {
      const error = yield* failure(client.request({ cwd: "/repo", url: invalid }));
      assert.strictEqual(error.outcome, "not-sent");
    }
    assert.strictEqual(f.calls.length, 0);
  }),
);

it.effect("resolves full and checkout-relative selectors within the configured collection", () =>
  Effect.gen(function* () {
    const f = fixture();
    const client = yield* f.client;
    const context = yield* client.resolve({ cwd: "/repo" });
    assert.strictEqual(context.repositoryPath, "tfs/Collection/Project/_git/Repo");
    assert.strictEqual(context.repositoryUrl, `${base}/Project/_git/Repo`);
    assert.strictEqual(Client.serverApiUrl(context, "git/repositories/Repo"), url);
    assert.strictEqual(
      (yield* client.resolve({ cwd: "/repo", repository: "Repo" })).repositoryUrl,
      context.repositoryUrl,
    );
    assert.strictEqual(
      (yield* client.resolve({ cwd: "/repo", repository: "Other" })).repositoryUrl,
      `${base}/Project/_git/Other`,
    );
    yield* client.resolve({ cwd: "/repo", repository: "tfs/Collection/Project/_git/Other" });
    for (const repository of ["Other/Project/_git/Repo", "tfs/CollectionOther/Project/_git/Repo"])
      yield* client.resolve({ cwd: "/repo", repository }).pipe(Effect.flip);
    yield* client
      .resolve({ cwd: "/repo", repository: context.repositoryPath, host: "elsewhere.example" })
      .pipe(Effect.flip);
  }),
);

it.effect.each([
  "ssh://ado.example:22/tfs/Collection/Project/_git/Repo",
  "ssh://git@ado.example:2222/tfs/Collection/Project/_git/Repo.git",
  "ssh://git@ADO.EXAMPLE:22/tfs/collection/Project/_git/Repo",
  "git@ado.example:tfs/Collection/Project/_git/Repo",
])("resolves SSH checkout %s using the configured HTTPS origin", (remoteUrl) =>
  Effect.gen(function* () {
    const f = fixture("pat", [200], "SSL", "win32", remoteUrl);
    const client = yield* f.client;
    const context = yield* client.resolve({ cwd: "/repo" });
    assert.strictEqual(context.repositoryUrl, `${base}/Project/_git/Repo`);
    assert.strictEqual(context.origin, "https://ado.example:8443");
    assert.strictEqual(
      (yield* client.resolve({ cwd: "/repo", repository: "Other" })).repositoryUrl,
      `${base}/Project/_git/Other`,
    );
    assert.strictEqual(
      (yield* client.resolve({ cwd: "/repo", remoteUrl })).repositoryUrl,
      context.repositoryUrl,
    );
    yield* client.resolve({ cwd: "/repo", remoteUrl, host: "elsewhere.example" }).pipe(Effect.flip);
    assert.strictEqual(f.calls.length, 0);
  }),
);

it.effect("rejects SSH checkouts outside the configured host or collection", () =>
  Effect.gen(function* () {
    for (const remoteUrl of [
      "ssh://elsewhere.example:22/tfs/Collection/Project/_git/Repo",
      "git@elsewhere.example:tfs/Collection/Project/_git/Repo",
      "ssh://ado.example:22/tfs/Other/Project/_git/Repo",
      "ssh://ado.example:22/tfs/CollectionOther/Project/_git/Repo",
      "ssh://ado.example:22/tfs/Collection/../Other/Project/_git/Repo",
      "ssh://ado.example:22/tfs/Collection/..\\Other/Project/_git/Repo",
      "ssh://ado.example:22/tfs/Collection/Project/_git/Repo?query=1",
      "ssh://ado.example:22/tfs/Collection/Project/_git/Repo#fragment",
      "ssh://ado.example:22/tfs/Collection/Project/_git/%2fRepo",
    ]) {
      const f = fixture("pat", [200], "SSL", "win32", remoteUrl);
      const client = yield* f.client;
      yield* client.resolve({ cwd: "/repo" }).pipe(Effect.flip);
      yield* client.resolve({ cwd: "/repo", remoteUrl }).pipe(Effect.flip);
      assert.strictEqual(f.calls.length, 0);
    }
  }),
);

it.effect("pins mutation auth after read preflight and never retries a rejected mutation", () =>
  Effect.gen(function* () {
    const f = fixture("auto", [200, 401], "SSPI SPNEGO SSL", "win32", undefined, "");
    const client = yield* f.client;
    const error = yield* failure(
      client.request({ cwd: "/repo", url, method: "POST", body: { title: "hi" } }),
    );
    assert.strictEqual(error.status, 401);
    assert.strictEqual(f.calls.length, 3);
    assert.ok(f.calls[1]!.args.includes("--negotiate"));
    // curl counts the Negotiate exchange against max-redirs even without following HTTP redirects.
    assert.ok(!f.calls[1]!.args.includes("--max-redirs"));
    assert.ok(f.calls[1]!.args.includes("GET"));
    assert.ok(f.calls[2]!.args.includes("POST"));
    assert.ok(f.calls[2]!.args.includes("--negotiate"));
  }),
);

it.effect("accepts collection case differences and removes Git user information", () =>
  Effect.gen(function* () {
    const f = fixture(
      "pat",
      [200],
      "SSL",
      "win32",
      "https://user@ado.example:8443/tfs/collection/Project/_git/Repo",
    );
    const client = yield* f.client;
    const context = yield* client.resolve({ cwd: "/repo" });
    assert.strictEqual(context.collectionUrl, base);
    assert.strictEqual(context.repositoryUrl, `${base}/Project/_git/Repo`);
    assert.ok(!context.repositoryUrl.includes("user@"));
    yield* client.request({ cwd: "/repo", url: url.replace("Collection", "collection") });
    assert.strictEqual(f.calls.length, 1);
  }),
);

it.effect("never retries failed Windows-authenticated reads with another identity", () =>
  Effect.gen(function* () {
    for (const status of [401, 403, 429, 500]) {
      const f = fixture("auto", [status], "SSPI SPNEGO SSL", "win32", undefined, "");
      const c = yield* f.client;
      const error = yield* failure(c.request({ cwd: "/repo", url }));
      assert.strictEqual(error.status, status);
      assert.strictEqual(f.calls.length, 2);
      assert.ok(!error.detail.includes(pat));
    }
  }),
);

it.effect("reports ambiguous write responses without replaying mutations", () =>
  Effect.gen(function* () {
    const f = fixture("pat", [500]);
    const client = yield* f.client;
    const error = yield* failure(client.request({ cwd: "/repo", url, method: "PATCH", body: {} }));
    assert.strictEqual(error.outcome, "unknown");
    assert.strictEqual(f.calls.length, 1);
  }),
);
