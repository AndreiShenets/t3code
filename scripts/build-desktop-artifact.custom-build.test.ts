import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { createBuildConfig, customBuildMetadataFromBranch } from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("custom desktop builds", (it) => {
  it("embeds the branch stamp and absolute build time only in custom builds", () => {
    const builtAt = "2026-10-17T13:42:03.000Z";
    assert.deepEqual(customBuildMetadataFromBranch("custom_builds/2026_10_17_15_39\n", builtAt), {
      t3codeCustomBuildStamp: "202610171539",
      t3codeCustomBuildTimestamp: builtAt,
    });
    assert.equal(customBuildMetadataFromBranch("main", builtAt), undefined);
    assert.equal(
      customBuildMetadataFromBranch("customizations/custom-build-updater", builtAt),
      undefined,
    );
  });

  it.effect("keeps upstream nightly updates separate from custom Windows releases", () =>
    Effect.gen(function* () {
      const custom = yield* createBuildConfig(
        "win",
        "nsis",
        "0.1.1",
        false,
        false,
        undefined,
        undefined,
        true,
        "x64",
        true,
      );
      const nightly = yield* createBuildConfig(
        "win",
        "nsis",
        "0.1.1-nightly.20261017.1",
        false,
        false,
        undefined,
        undefined,
        true,
        "x64",
      );
      assert.deepStrictEqual(custom.publish, [
        {
          provider: "github",
          owner: "pingdotgg",
          repo: "t3code",
          releaseType: "prerelease",
          channel: "nightly",
        },
      ]);
      assert.equal(custom.appId, nightly.appId);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "AndreiShenets/t3code" } }),
        ),
      ),
    ),
  );
});
