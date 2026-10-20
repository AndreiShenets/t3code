// @effect-diagnostics nodeBuiltinImport:off - Fixtures hash the same byte strings as the streamed installer.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as DesktopCustomBuildUpdates from "./DesktopCustomBuildUpdates.ts";
import { customBuildChecksum, selectCustomBuild } from "./customBuildRelease.ts";

const installer = "fixture Windows installer";
const checksum = NodeCrypto.createHash("sha256").update(installer).digest("hex");
const release = (stamp = "202610171539", version = "0.1.1") => {
  const tag = `as-custom-v${version}-${stamp}`;
  const name = `T3-Code-AS-Custom-${version}-${stamp}-x64.exe`;
  const asset = (name: string, size: number) => ({
    name,
    size,
    browser_download_url: `https://github.com/AndreiShenets/t3code/releases/download/${tag}/${name}`,
  });
  return {
    tag_name: tag,
    draft: false,
    assets: [asset(name, installer.length), asset("SHA256SUMS", 150)],
  };
};

const harness = (
  options: {
    currentStamp?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    packaged?: boolean;
    apiStatus?: number;
    body?: string;
    checksum?: string;
    launch?: boolean;
    nightlyBusy?: boolean;
    pages?: ReturnType<typeof release>[][];
    gate?: { started: Deferred.Deferred<void>; finish: Deferred.Deferred<void> };
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      JSON.stringify({ t3codeCustomBuildStamp: options.currentStamp }),
    );
    const quitting = yield* Ref.make(false);
    const backendReady = yield* Ref.make(true);
    const steps: string[] = [];
    const requests: string[] = [];
    let openedPath: string | null = null;
    let downloadPath: string | null = null;
    const layers = Layer.mergeAll(
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: options.platform ?? "win32",
        processArch: options.arch ?? "x64",
        isPackaged: options.packaged ?? true,
        appRoot: directory,
        appVersion: "0.1.1",
        customBuildStamp: options.currentStamp ?? null,
        path,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      Layer.succeed(DesktopState.DesktopState, { quitting, backendReady }),
      Layer.mock(ElectronWindow.ElectronWindow)({ sendAll: () => Effect.void }),
      Layer.mock(ElectronShell.ElectronShell)({
        openPath: (target) =>
          Effect.sync(() => {
            openedPath = target;
            steps.push("installer");
            return options.launch ?? true;
          }),
      }),
      Layer.mock(ElectronApp.ElectronApp)({
        quit: Effect.sync(() => {
          steps.push("quit");
        }),
      }),
      Layer.mock(DesktopUpdates.DesktopUpdates)({
        isActionActive: Effect.succeed(options.nightlyBusy ?? false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push(request.url);
            let body: string;
            let status = 200;
            if (request.url.startsWith("https://api.github.com/")) {
              const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
              body = JSON.stringify(options.pages?.[page - 1] ?? [release()]);
              status = options.apiStatus ?? 200;
            } else if (request.url.endsWith("SHA256SUMS")) {
              body = `${options.checksum ?? checksum}  ${release().assets[0]!.name}\n`;
            } else {
              if (options.gate) {
                yield* Deferred.succeed(options.gate.started, undefined);
                yield* Deferred.await(options.gate.finish);
              }
              body = options.body ?? installer;
            }
            return HttpClientResponse.fromWeb(request, new Response(body, { status }));
          }),
        ),
      ),
    );
    const updates = yield* DesktopCustomBuildUpdates.make.pipe(
      Effect.provide(layers),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        makeTempDirectory: (options) => fs.makeTempDirectory({ ...options, directory }),
        sink: (target, options) => {
          downloadPath = target;
          return fs.sink(target, options);
        },
      }),
    );
    return {
      updates,
      steps,
      requests,
      quitting,
      fs,
      get openedPath() {
        return openedPath;
      },
      get downloadPath() {
        return downloadPath;
      },
    };
  });

it.layer(NodeServices.layer)("custom builds", (it) => {
  it.effect("checks, downloads, verifies and opens the installer before graceful quit", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      assert.equal((yield* h.updates.act("check")).status, "available");
      assert.equal((yield* h.updates.act("download")).status, "downloaded");
      assert.equal((yield* h.updates.act("install")).status, "installing");
      assert.deepEqual(h.steps, ["installer", "quit"]);
      assert.equal(yield* Ref.get(h.quitting), true);
      assert.equal(yield* h.fs.readFileString(h.openedPath!), installer);
      yield* h.fs.remove(h.openedPath!);
    }),
  );

  it.effect("recognizes equal/older timestamps without comparing the shared base version", () =>
    Effect.gen(function* () {
      for (const stamp of ["202610171539", "202610181200"]) {
        const h = yield* harness({ currentStamp: stamp });
        assert.equal((yield* h.updates.act("check")).status, "up-to-date");
        assert.deepEqual(h.steps, []);
      }
      const newer = yield* harness({ currentStamp: "202610171538" });
      assert.equal((yield* newer.updates.act("check")).status, "available");
    }),
  );

  it.effect("finds custom prereleases beyond the first API page", () =>
    Effect.gen(function* () {
      const ordinary = { ...release(), tag_name: "v0.1.1-nightly.20261017.1" };
      const h = yield* harness({
        pages: [Array.from({ length: 100 }, () => ordinary), [release()]],
      });
      assert.equal((yield* h.updates.act("check")).availableBuild, "0.1.1 202610171539");
      assert.equal(h.requests.length, 2);
    }),
  );

  it.effect("does not launch corrupted downloads or missing/mismatched checksums", () =>
    Effect.gen(function* () {
      for (const options of [
        { body: "corrupt" },
        { checksum: "0".repeat(64) },
        { checksum: "invalid" },
      ]) {
        const h = yield* harness(options);
        yield* h.updates.act("check");
        const failed = yield* h.updates.act("download");
        assert.equal(failed.status, "available");
        assert.match(failed.message!, /checksum verification failed/);
        yield* h.updates.act("install");
        assert.deepEqual(h.steps, []);
        assert.equal(yield* Ref.get(h.quitting), false);
      }
    }),
  );

  it.effect("rechecks downloaded bytes before installation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.updates.act("check");
      yield* h.updates.act("download");
      yield* h.fs.writeFileString(h.downloadPath!, "tampered after download");
      const failed = yield* h.updates.act("install");
      assert.equal(failed.status, "available");
      assert.match(failed.message!, /checksum verification failed/);
      assert.deepEqual(h.steps, []);
      assert.equal(yield* Ref.get(h.quitting), false);
    }),
  );

  it.effect("leaves nightly work and the running app intact when installation cannot start", () =>
    Effect.gen(function* () {
      for (const options of [{ launch: false }, { nightlyBusy: true }]) {
        const h = yield* harness(options);
        yield* h.updates.act("check");
        yield* h.updates.act("download");
        const failed = yield* h.updates.act("install");
        assert.equal(failed.status, "downloaded");
        assert.ok(failed.message);
        assert.equal(yield* Ref.get(h.quitting), false);
        assert.ok(!h.steps.includes("quit"));
      }
    }),
  );

  it.effect("deduplicates concurrent downloads and exposes busy state to reopened settings", () =>
    Effect.gen(function* () {
      const gate = { started: yield* Deferred.make<void>(), finish: yield* Deferred.make<void>() };
      const h = yield* harness({ gate });
      yield* h.updates.act("check");
      const fiber = yield* h.updates.act("download").pipe(Effect.forkChild);
      yield* Deferred.await(gate.started);
      assert.equal((yield* h.updates.act("state")).status, "downloading");
      assert.equal((yield* h.updates.act("download")).status, "downloading");
      yield* Deferred.succeed(gate.finish, undefined);
      assert.equal((yield* Fiber.join(fiber)).status, "downloaded");
      assert.equal(h.requests.filter((url) => url.endsWith(".exe")).length, 1);
    }),
  );

  it.effect("reports GitHub errors and allows retry", () =>
    Effect.gen(function* () {
      const h = yield* harness({ apiStatus: 403 });
      const first = yield* h.updates.act("check");
      assert.equal(first.status, "idle");
      assert.match(first.message!, /GitHub/);
      yield* h.updates.act("check");
      assert.equal(h.requests.length, 2);
    }),
  );

  it.effect("offers no install when no custom release has been published", () =>
    Effect.gen(function* () {
      const h = yield* harness({ pages: [[]] });
      const checked = yield* h.updates.act("check");
      assert.equal(checked.status, "up-to-date");
      assert.equal(checked.availableBuild, null);
      yield* h.updates.act("download");
      yield* h.updates.act("install");
      assert.deepEqual(h.steps, []);
      assert.equal(h.requests.length, 1);
    }),
  );

  it.effect("cleans a superseded download when checking again", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.updates.act("check");
      yield* h.updates.act("download");
      const path = h.downloadPath!;
      assert.equal(yield* h.fs.exists(path), true);
      assert.equal((yield* h.updates.act("check")).status, "available");
      assert.equal(yield* h.fs.exists(path), false);
    }),
  );

  it.effect("does not fetch or install on unsupported platforms/architectures or dev apps", () =>
    Effect.gen(function* () {
      for (const options of [
        { platform: "linux" as const },
        { arch: "arm64" },
        { packaged: false },
      ]) {
        const h = yield* harness(options);
        assert.equal((yield* h.updates.act("check")).supported, false);
        assert.deepEqual(h.requests, []);
        assert.deepEqual(h.steps, []);
      }
    }),
  );
});

it("ignores drafts, unrelated, incomplete and foreign-repository assets", () => {
  const good = release();
  assert.equal(
    selectCustomBuild([
      { ...release("202610181000"), draft: true },
      { ...release("202610191000"), assets: [] },
      {
        ...release("202610201000"),
        assets: release("202610201000").assets.map((asset) => ({
          ...asset,
          browser_download_url: asset.browser_download_url.replace("AndreiShenets", "elsewhere"),
        })),
      },
      good,
    ])?.stamp,
    "202610171539",
  );
  assert.equal(selectCustomBuild([]), null);
  assert.equal(
    customBuildChecksum(`${checksum}  installer.exe\n${checksum}  installer.exe`, "installer.exe"),
    null,
  );
});
