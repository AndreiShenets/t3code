import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { settings as serverSettings } from "../shared/customDefinition.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface AzureDevOpsServerContext {
  readonly origin: string;
  readonly collectionUrl: string;
  readonly projectUrl: string;
  readonly project: string;
  readonly repository: string;
  readonly repositoryPath: string;
  readonly repositoryUrl: string;
}

export class AzureDevOpsServerError extends Schema.TaggedError<AzureDevOpsServerError>()(
  "AzureDevOpsServerError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "missing-tool",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "failed",
    ]),
    status: Schema.optional(Schema.Number),
    outcome: Schema.optional(Schema.Literals(["not-sent", "unknown", "rejected"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    if (this.operation === "settings")
      return "Enter a full HTTPS collection URL in Source Control settings. Add a PAT, or leave it empty to use Windows credentials.";
    switch (this.reason) {
      case "missing-tool":
        return "System curl is unavailable.";
      case "unauthenticated":
        return "Authentication failed. Check the saved PAT, or leave it empty to use Windows credentials. A PAT is required on macOS/Linux.";
      case "rate-limited":
        return "Azure DevOps Server rate limit exceeded.";
      case "not-found":
        return "Azure DevOps Server resource not found.";
      default:
        return "Azure DevOps Server request failed. Check the configured collection and repository.";
    }
  }
  override get message(): string {
    return this.detail;
  }
}

const isServerError = Schema.is(AzureDevOpsServerError);
const decodeSettings = Schema.decodeUnknownEffect(serverSettings);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class AzureDevOpsServerClient extends Context.Service<
  AzureDevOpsServerClient,
  {
    readonly resolve: (input: {
      readonly cwd: string;
      readonly repository?: string;
      readonly host?: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<AzureDevOpsServerContext, AzureDevOpsServerError>;
    readonly request: (input: {
      readonly cwd: string;
      readonly url: string;
      readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      readonly body?: unknown;
    }) => Effect.Effect<unknown, AzureDevOpsServerError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsServerClient") {}

function collection(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%2f|%5c/i.test(url.pathname)
  )
    throw new Error("Invalid collection");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "/") throw new Error("Collection path required");
  return url;
}

function within(url: URL, base: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.origin === base.origin &&
    !/%2f|%5c/i.test(url.pathname) &&
    (url.pathname.toLowerCase() === base.pathname.toLowerCase() ||
      url.pathname.toLowerCase().startsWith(`${base.pathname.toLowerCase()}/`))
  );
}

function remoteToCollectionUrl(remoteUrl: string, base: URL): URL {
  const trimmed = remoteUrl.trim();
  const scp = /^[a-zA-Z0-9._-]+@([^:/]+):(.+)$/u.exec(trimmed);
  const remote = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : trimmed);
  if (remote.search || remote.hash) throw new Error("Invalid repository remote");
  if (remote.protocol === "ssh:" && remote.hostname.toLowerCase() === base.hostname.toLowerCase()) {
    // The configured collection owns the web origin; SSH's user and port do not.
    const url = new URL(base.origin);
    url.pathname = remote.pathname;
    return url;
  }
  if (remote.protocol !== "https:") throw new Error("Invalid repository remote");
  remote.username = "";
  remote.password = "";
  return remote;
}

function configQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

export function serverApiUrl(
  context: AzureDevOpsServerContext,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> = {},
): string {
  const url = new URL(`${context.projectUrl}/_apis/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(key, String(value));
  url.searchParams.set("api-version", "7.0");
  return url.href;
}

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  let integratedSupport: boolean | undefined;
  const readSettings = Effect.fnUntraced(function* () {
    const settings = yield* host.settings.get.pipe(
      Effect.mapError(
        (cause) =>
          new AzureDevOpsServerError({
            operation: "settings",
            reason: "failed",
            outcome: "not-sent",
            cause,
          }),
      ),
    );
    const decoded = yield* decodeSettings(
      settings.sourceControlHosts["azure-devops-custom-server"] ?? {},
    ).pipe(
      Effect.mapError(
        () =>
          new AzureDevOpsServerError({
            operation: "settings",
            reason: "failed",
            outcome: "not-sent",
          }),
      ),
    );
    const base = yield* Effect.try({
      try: () => collection(decoded.collectionUrl ?? ""),
      catch: () =>
        new AzureDevOpsServerError({
          operation: "settings",
          reason: "failed",
          outcome: "not-sent",
        }),
    });
    return {
      base,
      pat: decoded.personalAccessToken ?? "",
    };
  });

  const resolve = Effect.fnUntraced(function* (input: {
    readonly cwd: string;
    readonly repository?: string;
    readonly host?: string;
    readonly remoteUrl?: string;
  }) {
    const { base } = yield* readSettings();
    return yield* Effect.gen(function* () {
      if (input.host !== undefined && input.host !== base.host && input.host !== base.origin)
        return yield* new AzureDevOpsServerError({
          operation: "resolve",
          reason: "failed",
          outcome: "not-sent",
        });
      let url: URL;
      const selector = input.repository?.replace(/^\/+|\/+$/g, "");
      if (selector?.includes("/")) {
        const path = selector.toLowerCase().startsWith(`${base.host.toLowerCase()}/`)
          ? selector.slice(base.host.length + 1)
          : selector;
        url = yield* Effect.try({
          try: () => new URL(`/${path}`, base.origin),
          catch: () =>
            new AzureDevOpsServerError({
              operation: "resolve",
              reason: "failed",
              outcome: "not-sent",
            }),
        });
      } else {
        let remoteUrl = input.remoteUrl;
        if (remoteUrl === undefined) {
          const remotes = yield* yield* host.git.remotes(input.cwd);
          const remote =
            remotes.remotes.find((entry) => entry.name === "origin") ??
            (remotes.remotes.length === 1 ? remotes.remotes[0] : undefined);
          if (!remote)
            return yield* new AzureDevOpsServerError({
              operation: "resolve",
              reason: "not-found",
              outcome: "not-sent",
            });
          remoteUrl = remote.url;
        }
        url = yield* Effect.try({
          try: () => remoteToCollectionUrl(remoteUrl, base),
          catch: () =>
            new AzureDevOpsServerError({
              operation: "resolve",
              reason: "failed",
              outcome: "not-sent",
            }),
        });
        if (selector) {
          url.pathname = url.pathname.replace(/[^/]+\/?$/, encodeURIComponent(selector));
        }
      }
      if (!within(url, base) || url.search)
        return yield* new AzureDevOpsServerError({
          operation: "resolve",
          reason: "failed",
          outcome: "not-sent",
        });
      const parts = url.pathname
        .slice(base.pathname.length + 1)
        .replace(/\/+$/, "")
        .split("/");
      if (parts.length !== 3 || parts[1] !== "_git" || !parts[0] || !parts[2])
        return yield* new AzureDevOpsServerError({
          operation: "resolve",
          reason: "failed",
          outcome: "not-sent",
        });
      const [project, repository] = yield* Effect.try({
        try: () =>
          [
            decodeURIComponent(parts[0]!),
            decodeURIComponent(parts[2]!).replace(/\.git$/, ""),
          ] as const,
        catch: () =>
          new AzureDevOpsServerError({
            operation: "resolve",
            reason: "failed",
            outcome: "not-sent",
          }),
      });
      const projectUrl = `${base.origin}${base.pathname}/${encodeURIComponent(project)}`;
      const repositoryUrl = `${projectUrl}/_git/${encodeURIComponent(repository)}`;
      return {
        origin: base.origin,
        collectionUrl: `${base.origin}${base.pathname}`,
        projectUrl,
        project,
        repository,
        repositoryPath: new URL(repositoryUrl).pathname.slice(1),
        repositoryUrl,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isServerError(cause)
          ? cause
          : new AzureDevOpsServerError({
              operation: "resolve",
              reason: "failed",
              outcome: "not-sent",
              cause,
            }),
      ),
    );
  });

  const request: AzureDevOpsServerClient["Service"]["request"] = Effect.fnUntraced(
    function* (input) {
      const settings = yield* readSettings();
      const url = yield* Effect.try({
        try: () => new URL(input.url),
        catch: () =>
          new AzureDevOpsServerError({
            operation: "request",
            reason: "failed",
            outcome: "not-sent",
          }),
      });
      if (!within(url, settings.base))
        return yield* new AzureDevOpsServerError({
          operation: "request",
          reason: "failed",
          outcome: "not-sent",
        });
      const method = input.method ?? "GET";
      const mutation = method !== "GET";
      const command =
        platform === "win32"
          ? `${environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows"}\\System32\\curl.exe`
          : "curl";
      // Keep corporate proxy/CA configuration, but never pass a PAT through the child's environment.
      const basic = settings.pat ? Buffer.from(`:${settings.pat}`, "utf8").toString("base64") : "";
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [
          key,
          key.toUpperCase() === "AZURE_DEVOPS_PAT" ||
          (settings.pat && value?.includes(settings.pat)) ||
          (basic && value?.includes(basic))
            ? undefined
            : value,
        ]),
      );
      const run = (args: ReadonlyArray<string>, stdin?: string, sent = false) =>
        host.process
          .run({
            operation: "azureDevOpsServer",
            command,
            args,
            cwd: input.cwd,
            env,
            ...(stdin !== undefined ? { stdin } : {}),
            allowNonZeroExit: true,
            timeoutMs: 35_000,
            maxOutputBytes: 8 * 1024 * 1024,
            outputMode: "error",
          })
          .pipe(
            Effect.mapError((cause) => {
              const missing =
                cause._tag === "VcsProcessSpawnError" &&
                cause.cause instanceof PlatformError.PlatformError &&
                cause.cause.reason._tag === "NotFound" &&
                cause.cause.reason.syscall !== "chdir" &&
                cause.cause.reason.pathOrDescriptor !== input.cwd;
              return new AzureDevOpsServerError({
                operation: "request",
                reason: missing ? "missing-tool" : "failed",
                outcome:
                  missing || cause._tag === "VcsProcessSpawnError"
                    ? "not-sent"
                    : sent
                      ? "unknown"
                      : "not-sent",
              });
            }),
          );
      let integrated = false;
      if (!settings.pat && platform === "win32") {
        if (integratedSupport === undefined) {
          const version = yield* run(["-q", "--version"]);
          integratedSupport =
            version.exitCode === 0 &&
            /\bSSPI\b/.test(version.stdout) &&
            /\bSPNEGO\b/.test(version.stdout);
        }
        integrated = integratedSupport;
      }
      if (!integrated && !settings.pat)
        return yield* new AzureDevOpsServerError({
          operation: "request",
          reason: "unauthenticated",
          outcome: "not-sent",
        });
      const send = Effect.fnUntraced(function* (
        target: string,
        verb: string,
        auth: "integrated" | "pat",
        body?: unknown,
      ) {
        const config: string[] = [];
        if (auth === "pat")
          config.push(
            `header = ${configQuote(`Authorization: Basic ${Buffer.from(`:${settings.pat}`, "utf8").toString("base64")}`)}`,
          );
        if (body !== undefined) {
          const encoded = yield* encodeJson(body).pipe(
            Effect.mapError(
              () =>
                new AzureDevOpsServerError({
                  operation: "encode",
                  reason: "failed",
                  outcome: "not-sent",
                }),
            ),
          );
          config.push(`data-binary = ${configQuote(encoded)}`);
        }
        const result = yield* run(
          [
            "-q",
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--request",
            verb,
            "--header",
            "Accept: application/json",
            "--header",
            "Content-Type: application/json",
            "--write-out",
            "\nT3_HTTP_STATUS:%{http_code}",
            ...(auth === "integrated" ? ["--negotiate", "--user", ":"] : []),
            "--url",
            target,
          ],
          `${config.join("\n")}\n`,
          verb !== "GET",
        );
        if (result.exitCode !== 0 || result.stdoutTruncated || result.stdoutInvalidUtf8)
          return yield* new AzureDevOpsServerError({
            operation: "request",
            reason: result.exitCode === 2 || result.exitCode === 4 ? "missing-tool" : "failed",
            outcome: verb !== "GET" ? "unknown" : "not-sent",
          });
        const match = /\nT3_HTTP_STATUS:(\d{3})$/.exec(result.stdout);
        if (!match)
          return yield* new AzureDevOpsServerError({
            operation: "request",
            reason: "failed",
            outcome: verb !== "GET" ? "unknown" : "not-sent",
          });
        return { status: Number(match[1]), body: result.stdout.slice(0, match.index) };
      });
      const check = Effect.fnUntraced(function* (
        response: { status: number; body: string },
        sent: boolean,
      ) {
        if (response.status < 200 || response.status >= 300)
          return yield* new AzureDevOpsServerError({
            operation: "request",
            reason:
              response.status === 401
                ? "unauthenticated"
                : response.status === 404
                  ? "not-found"
                  : response.status === 429
                    ? "rate-limited"
                    : "failed",
            status: response.status,
            outcome:
              sent && (response.status >= 500 || response.status === 408) ? "unknown" : "rejected",
          });
        return response;
      });
      const auth: "integrated" | "pat" = integrated ? "integrated" : "pat";
      if (mutation && integrated) {
        const probeUrl = `${settings.base.origin}${settings.base.pathname}/_apis/connectionData?api-version=7.0-preview.1`;
        const probe = yield* send(probeUrl, "GET", auth);
        yield* check(probe, false);
      }
      const response = yield* send(url.href, method, auth, input.body);
      yield* check(response, mutation);
      if (!response.body.trim()) return undefined;
      return yield* decodeJson(response.body).pipe(
        Effect.mapError(
          () =>
            new AzureDevOpsServerError({
              operation: "decode",
              reason: "failed",
              outcome: mutation ? "unknown" : "rejected",
            }),
        ),
      );
    },
  );
  return AzureDevOpsServerClient.of({ resolve, request });
});

export const layer = Layer.effect(AzureDevOpsServerClient, make);
