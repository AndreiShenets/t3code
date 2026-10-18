import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  autoUpdaterOnMock,
  autoUpdaterRemoveListenerMock,
  exitMock,
  getAppPathMock,
  getSystemLocaleMock,
  getVersionMock,
  onMock,
  quitMock,
  relaunchMock,
  removeListenerMock,
  removeSwitchMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setAsDefaultProtocolClientMock,
  setDesktopNameMock,
  setDockIconMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  autoUpdaterOnMock: vi.fn(),
  autoUpdaterRemoveListenerMock: vi.fn(),
  exitMock: vi.fn(),
  getAppPathMock: vi.fn(() => "/app"),
  getSystemLocaleMock: vi.fn(() => "en-GB"),
  getVersionMock: vi.fn(() => "1.2.3"),
  onMock: vi.fn(),
  quitMock: vi.fn(),
  relaunchMock: vi.fn(),
  removeListenerMock: vi.fn(),
  removeSwitchMock: vi.fn(),
  setAboutPanelOptionsMock: vi.fn(),
  setAppUserModelIdMock: vi.fn(),
  setAsDefaultProtocolClientMock: vi.fn(() => true),
  setDesktopNameMock: vi.fn(),
  setDockIconMock: vi.fn(),
  setNameMock: vi.fn(),
  setPathMock: vi.fn(),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  autoUpdater: {
    on: autoUpdaterOnMock,
    removeListener: autoUpdaterRemoveListenerMock,
  },
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
      removeSwitch: removeSwitchMock,
    },
    dock: {
      setIcon: setDockIconMock,
    },
    getAppPath: getAppPathMock,
    getSystemLocale: getSystemLocaleMock,
    getVersion: getVersionMock,
    isPackaged: true,
    name: "T3 Code",
    on: onMock,
    quit: quitMock,
    relaunch: relaunchMock,
    removeListener: removeListenerMock,
    runningUnderARM64Translation: false,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
    exit: exitMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    autoUpdaterOnMock.mockClear();
    autoUpdaterRemoveListenerMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    removeListenerMock.mockClear();
    removeSwitchMock.mockClear();
    setPathMock.mockClear();
  });

  it.effect("reads app metadata through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.deepEqual(metadata, {
        appVersion: "1.2.3",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: process.resourcesPath,
        runningUnderArm64Translation: false,
      });
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("reads the OS locale through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;

      assert.strictEqual(yield* electronApp.systemLocale, "en-GB");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect(
    "reads the custom build stamp from packaged metadata without changing the app version",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          `${directory}/package.json`,
          JSON.stringify({
            t3codeCustomBuildStamp: "202610171539",
            t3codeCustomBuildTimestamp: "2026-10-17T13:42:03.000Z",
          }),
        );
        getAppPathMock.mockReturnValueOnce(directory);
        const metadata = yield* ElectronApp.make.metadata;
        assert.equal(metadata.customBuildStamp, "202610171539");
        assert.equal(metadata.customBuildTimestamp, "2026-10-17T13:42:03.000Z");
        assert.equal(metadata.appVersion, "1.2.3");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([undefined, 42])(
    "retains the custom stamp without a valid timestamp (%s)",
    (timestamp) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          `${directory}/package.json`,
          JSON.stringify({
            t3codeCustomBuildStamp: "202610171539",
            t3codeCustomBuildTimestamp: timestamp,
          }),
        );
        getAppPathMock.mockReturnValueOnce(directory);
        const metadata = yield* ElectronApp.make.metadata;
        assert.equal(metadata.customBuildStamp, "202610171539");
        assert.isUndefined(metadata.customBuildTimestamp);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("normalizes POSIX-style locale identifiers that Intl rejects", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "en_GB");
      const electronApp = yield* ElectronApp.ElectronApp;

      assert.strictEqual(yield* electronApp.systemLocale, "en-GB");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("reports which app metadata property failed", () =>
    Effect.gen(function* () {
      const cause = new Error("version unavailable");
      getVersionMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.metadata.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppMetadataReadError);
      assert.strictEqual(error.property, "app-version");
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        'Failed to read Electron app metadata property "app-version".',
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("preserves Electron readiness failures", () =>
    Effect.gen(function* () {
      const cause = new Error("ready failed");
      whenReadyMock.mockRejectedValueOnce(cause);

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.whenReady.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppWhenReadyError);
      assert.strictEqual(error.isPackaged, true);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        "Failed to wait for the Electron app to become ready (packaged: true).",
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes app event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.on("activate", listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["activate", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["activate", listener]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes native updater quit listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.onBeforeQuitForUpdate(listener);
        }),
      );

      assert.deepEqual(autoUpdaterOnMock.mock.calls, [["before-quit-for-update", listener]]);
      assert.deepEqual(autoUpdaterRemoveListenerMock.mock.calls, [
        ["before-quit-for-update", listener],
      ]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("removes command-line switches through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp.removeCommandLineSwitch("password-store");

      assert.deepEqual(removeSwitchMock.mock.calls, [["password-store"]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
