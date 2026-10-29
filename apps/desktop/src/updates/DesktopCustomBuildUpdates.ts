// @effect-diagnostics nodeBuiltinImport:off - Incremental hashing keeps installers out of memory.
import * as NodeCrypto from "node:crypto";
import { type DesktopCustomBuildAction, type DesktopCustomBuildState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  CUSTOM_BUILD_REPOSITORY,
  CustomBuildReleases,
  customBuildChecksum,
  selectCustomBuild,
} from "./customBuildRelease.ts";

const ERROR_MESSAGES = {
  unsupported: "Custom build installation is available only in packaged Windows x64 apps.",
  check: "Could not check custom releases on GitHub. Try again later.",
  download: "Could not download the custom installer. Retry the download.",
  checksum: "Custom installer checksum verification failed. Check the published release.",
  install: "Could not start the custom installer. Your current installation is unchanged.",
  busy: "Another update action is in progress. Wait for it to finish.",
  unavailable: "Check for a custom build and download it before installing.",
} as const;

class CustomBuildUpdateError extends Schema.TaggedError<CustomBuildUpdateError>()(
  "CustomBuildUpdateError",
  {
    reason: Schema.Literals([
      "unsupported",
      "check",
      "download",
      "checksum",
      "install",
      "busy",
      "unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return ERROR_MESSAGES[this.reason];
  }
}

export class DesktopCustomBuildUpdates extends Context.Service<
  DesktopCustomBuildUpdates,
  {
    readonly act: (action: DesktopCustomBuildAction) => Effect.Effect<DesktopCustomBuildState>;
  }
>()("@t3tools/desktop/updates/DesktopCustomBuildUpdates") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const client = HttpClient.followRedirects(yield* HttpClient.HttpClient);
  const windows = yield* ElectronWindow.ElectronWindow;
  const shell = yield* ElectronShell.ElectronShell;
  const app = yield* ElectronApp.ElectronApp;
  const desktopState = yield* DesktopState.DesktopState;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const currentStamp = environment.customBuildStamp;
  const state = yield* Ref.make<DesktopCustomBuildState>({
    supported:
      environment.platform === "win32" &&
      environment.processArch === "x64" &&
      environment.isPackaged,
    status: "idle",
    currentBuild: currentStamp ? `${environment.appVersion} ${currentStamp}` : null,
    availableBuild: null,
    message: null,
  });
  const active = yield* Ref.make(false);
  let release: ReturnType<typeof selectCustomBuild> = null;
  let downloaded: { path: string; sha256: string } | null = null;

  const setState = (next: DesktopCustomBuildState) =>
    Ref.set(state, next).pipe(
      Effect.andThen(windows.sendAll(IpcChannels.CUSTOM_BUILD_STATE_CHANNEL, next)),
      Effect.as(next),
    );
  const request = (url: string) =>
    client
      .get(url, { headers: { "User-Agent": "T3-Code-AS-Custom" } })
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const hashFile = (path: string) =>
    fs.stream(path).pipe(
      Stream.runFold(
        () => NodeCrypto.createHash("sha256"),
        (hash, chunk) => hash.update(chunk),
      ),
      Effect.map((hash) => hash.digest("hex")),
    );
  const check = Effect.gen(function* () {
    const all: Array<(typeof CustomBuildReleases.Type)[number]> = [];
    for (let page = 1; ; page++) {
      const response = yield* request(
        `https://api.github.com/repos/${CUSTOM_BUILD_REPOSITORY}/releases?per_page=100&page=${page}`,
      );
      const batch = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CustomBuildReleases)),
      );
      all.push(...batch);
      if (batch.length < 100) break;
    }
    release = selectCustomBuild(all);
    if (downloaded) yield* fs.remove(downloaded.path, { force: true }).pipe(Effect.ignore);
    downloaded = null;
    const newer = release && (!currentStamp || release.stamp > currentStamp);
    return {
      status: newer ? "available" : "up-to-date",
      availableBuild: release?.label ?? null,
    } as const;
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => new CustomBuildUpdateError({ reason: "check", cause })),
  );

  const download = Effect.gen(function* () {
    if (!release) return yield* new CustomBuildUpdateError({ reason: "unavailable" });
    const selected = release;
    const expected = yield* Effect.gen(function* () {
      const response = yield* request(selected.checksums.browser_download_url);
      const text = yield* response.text;
      return customBuildChecksum(text, selected.installer.name);
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) => new CustomBuildUpdateError({ reason: "download", cause })),
    );
    if (!expected) return yield* new CustomBuildUpdateError({ reason: "checksum" });
    const path = yield* Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectory({ prefix: "t3-custom-update-" });
      const target = environment.path.join(directory, selected.installer.name);
      yield* Effect.gen(function* () {
        const response = yield* request(selected.installer.browser_download_url);
        yield* response.stream.pipe(Stream.run(fs.sink(target)));
      }).pipe(
        Effect.onError(() =>
          fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
      return target;
    }).pipe(
      Effect.timeout("30 minutes"),
      Effect.mapError((cause) => new CustomBuildUpdateError({ reason: "download", cause })),
    );
    const hash = yield* hashFile(path).pipe(
      Effect.mapError((cause) => new CustomBuildUpdateError({ reason: "download", cause })),
    );
    const info = yield* fs
      .stat(path)
      .pipe(Effect.mapError((cause) => new CustomBuildUpdateError({ reason: "download", cause })));
    if (hash !== expected || Number(info.size) !== selected.installer.size) {
      yield* fs.remove(path, { force: true }).pipe(Effect.ignore);
      return yield* new CustomBuildUpdateError({ reason: "checksum" });
    }
    downloaded = { path, sha256: expected };
    return { status: "downloaded" } as const;
  });

  const install = Effect.gen(function* () {
    if (!downloaded) return yield* new CustomBuildUpdateError({ reason: "unavailable" });
    const selected = downloaded;
    const hash = yield* hashFile(selected.path).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          downloaded = null;
        }),
      ),
      Effect.mapError((cause) => new CustomBuildUpdateError({ reason: "download", cause })),
    );
    if (hash !== selected.sha256) {
      downloaded = null;
      yield* fs.remove(selected.path, { force: true }).pipe(Effect.ignore);
      return yield* new CustomBuildUpdateError({ reason: "checksum" });
    }
    if ((yield* updates.isActionActive) || (yield* Ref.getAndSet(desktopState.quitting, true))) {
      return yield* new CustomBuildUpdateError({ reason: "busy" });
    }
    if (!(yield* shell.openPath(selected.path))) {
      yield* Ref.set(desktopState.quitting, false);
      return yield* new CustomBuildUpdateError({ reason: "install" });
    }
    yield* app.quit;
    return { status: "installing" } as const;
  });

  return DesktopCustomBuildUpdates.of({
    act: Effect.fn("desktop.customBuildUpdates.act")(function* (action) {
      const before = yield* Ref.get(state);
      if (action === "state") return before;
      if (yield* Ref.getAndSet(active, true)) return before;
      return yield* Effect.gen(function* () {
        if (!before.supported) return yield* new CustomBuildUpdateError({ reason: "unsupported" });
        if (yield* Ref.get(desktopState.quitting))
          return yield* new CustomBuildUpdateError({ reason: "busy" });
        if (
          (action === "download" && before.status !== "available") ||
          (action === "install" && before.status !== "downloaded")
        ) {
          return yield* new CustomBuildUpdateError({ reason: "unavailable" });
        }
        yield* setState({
          ...before,
          status:
            action === "check" ? "checking" : action === "download" ? "downloading" : "installing",
          message: null,
        });
        const next = yield* action === "check" ? check : action === "download" ? download : install;
        return yield* setState({ ...before, ...next, message: null });
      }).pipe(
        Effect.catchTags({
          CustomBuildUpdateError: (error) =>
            setState({
              ...before,
              status: before.status === "downloaded" && !downloaded ? "available" : before.status,
              message: error.message,
            }),
        }),
        Effect.onInterrupt(() => setState(before)),
        Effect.ensuring(Ref.set(active, false)),
      );
    }),
  });
});

export const layer = Layer.effect(DesktopCustomBuildUpdates, make);
