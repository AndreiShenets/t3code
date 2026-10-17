import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

const customBuild = {
  customBuildStamp: "202610171901",
  customBuildTimestamp: "2026-10-17T19:01:00+02:00",
};
const nightlyVersion = "1.2.4-nightly.20261017.3238";

describe("official updates from custom builds", () => {
  it.effect("hides the older official nightly from the installed October 17 custom build", () => {
    const harness = makeHarness({
      customBuildStamp: "202610172110",
      customBuildTimestamp: "2026-10-17T19:55:49.067Z",
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("nightly");
        yield* updates.check("startup");
        harness.emit("update-available", {
          version: "0.1.1-nightly.20261017.3272",
          releaseDate: "2026-10-17T17:53:55.986Z",
        });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "up-to-date");
        assert.isNull(state.availableVersion);
        assert.isNull(state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect.each(["2026-10-17T16:59:00Z", "2026-10-17T17:01:00Z", "2026-10-18T01:00:00+08:00"])(
    "hides an older/equal nightly (%s) across checks and late downloads",
    (releaseDate) => {
      const harness = makeHarness(customBuild);
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          assert.equal(environment.customBuildTimestamp, customBuild.customBuildTimestamp);
          yield* updates.configure;
          yield* updates.setChannel("nightly");
          const firstEvent = harness.sentStates.length;

          for (const reason of ["startup", "poll", "manual"]) {
            yield* updates.check(reason);
            harness.emit("update-available", { version: nightlyVersion, releaseDate });
            yield* flushCallbacks;
            const state = yield* updates.getState;
            assert.equal(state.status, "up-to-date");
            assert.isNull(state.availableVersion);
            assert.isNull(state.downloadedVersion);
            assert.deepEqual(state.releaseNotes, []);
          }

          harness.emit("update-downloaded", { version: nightlyVersion, releaseDate });
          yield* flushCallbacks;
          const download = yield* updates.download;
          assert.isFalse(download.accepted);
          assert.equal(harness.downloadCount(), 0);
          const install = yield* updates.install;
          assert.isFalse(install.accepted);
          assert.equal(harness.quitAndInstalls(), 0);
          assert.equal(install.state.status, "up-to-date");
          assert.isTrue(
            harness.sentStates.slice(firstEvent).every((state) => state.availableVersion === null),
          );
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect.each([
    ["newer nightly", "2026-10-17T17:02:00Z"],
    ["missing release time", undefined],
    ["invalid release time", "invalid"],
    ["malformed release time", 42],
    ["release time without a timezone", "2026-10-17T16:00:00"],
  ] as const)("continues offering updates for a %s", (_label, releaseDate) => {
    const harness = makeHarness(customBuild);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("nightly");
        harness.emit("update-available", { version: nightlyVersion, releaseDate });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, nightlyVersion);
        assert.equal(harness.sentStates.at(-1)?.availableVersion, nightlyVersion);
        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.equal(harness.downloadCount(), 1);
        harness.emit("update-downloaded", { version: nightlyVersion, releaseDate });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).status, "downloaded");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect.each([
    {},
    { customBuildStamp: customBuild.customBuildStamp },
    { ...customBuild, customBuildTimestamp: "invalid" },
    { ...customBuild, customBuildTimestamp: "2026-10-17T19:01:00" },
    { customBuildTimestamp: customBuild.customBuildTimestamp },
  ])("preserves normal checks without reliable custom metadata (%j)", (options) => {
    const harness = makeHarness(options);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("nightly");
        harness.emit("update-available", {
          version: nightlyVersion,
          releaseDate: "2026-10-16T00:00:00Z",
        });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not filter the explicitly selected stable track", () => {
    const harness = makeHarness(customBuild);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest");
        harness.emit("update-available", {
          version: "1.2.4",
          releaseDate: "2026-10-16T00:00:00Z",
        });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a newer queued nightly when an older feed result arrives", () => {
    const harness = makeHarness(customBuild);
    const newerNightly = "1.2.4-nightly.20261018.1";
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("nightly");
        const newer = { version: newerNightly, releaseDate: "2026-10-18T00:00:00Z" };
        harness.emit("update-available", newer);
        yield* flushCallbacks;
        harness.emit("update-downloaded", newer);
        yield* flushCallbacks;
        yield* updates.check("poll");
        harness.emit("update-available", {
          version: nightlyVersion,
          releaseDate: "2026-10-16T00:00:00Z",
        });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, newerNightly);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
