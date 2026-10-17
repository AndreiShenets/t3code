import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";

import { applyWebBrandAssetsCommand } from "./apply-web-brand-assets.ts";
import { resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { isCustomBuildBranch, readCustomBuildBranding } from "./lib/custom-build-branding.ts";

const runCli = Command.runWith(applyWebBrandAssetsCommand, { version: "0.0.0" });

it.layer(NodeServices.layer)("custom-build web branding", (it) => {
  it.each([
    ["custom_builds/2026_10_17_19_01\n", true],
    ["main", false],
    ["customizations/nightly-branding", false],
    ["custom_builds/2026_10_17", false],
    ["", false],
  ] as const)("detects custom build branches only (%s)", (branch, expected) => {
    assert.equal(isCustomBuildBranch(branch), expected);
  });

  it.effect.each([
    { branch: "custom_builds/2026_10_17_19_01", requested: "production", expected: "nightly" },
    { branch: "custom_builds/2026_10_17_19_01", requested: "nightly", expected: "nightly" },
    { branch: "custom_builds/2026_10_17_19_01", requested: "development", expected: "development" },
    { branch: "main", requested: "production", expected: "production" },
    { branch: "customizations/nightly-branding", requested: "production", expected: "production" },
    { branch: "", requested: "production", expected: "production" },
  ] as const)("copies the correct actual favicon bytes (%j)", ({ branch, requested, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = yield* fs.makeTempDirectoryScoped();
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const spawner = ChildProcessSpawner.make(() => Effect.die("unexpected spawn"));
      yield* runCli([requested, target]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
          ...spawner,
          string: () => Effect.succeed(branch),
        }),
      );
      for (const icon of resolveWebIconOverrides(expected, target)) {
        assert.deepEqual(
          yield* fs.readFile(icon.targetRelativePath),
          yield* fs.readFile(path.join(repoRoot, icon.sourceRelativePath)),
        );
      }
    }),
  );

  it.effect("falls back to normal branding when Git is unavailable", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.die("unexpected spawn"));
    return readCustomBuildBranding("/repo").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        string: () =>
          Effect.fail(
            PlatformError.systemError({
              module: "ChildProcess",
              method: "spawn",
              _tag: "NotFound",
              pathOrDescriptor: "git",
            }),
          ),
      }),
      Effect.map((customBuild) => assert.isFalse(customBuild)),
    );
  });
});
