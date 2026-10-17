import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import { resolveWebIconOverrides } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("web branding", (it) => {
  it.effect.each(["production", "nightly", "development"] as const)(
    "copies Nightly release assets and preserves development assets (%s)",
    (brand) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = yield* fs.makeTempDirectoryScoped();
        const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
        yield* applyWebBrandAssets(brand, target);
        for (const icon of resolveWebIconOverrides(
          brand === "development" ? brand : "nightly",
          target,
        )) {
          assert.deepEqual(
            yield* fs.readFile(icon.targetRelativePath),
            yield* fs.readFile(path.join(root, icon.sourceRelativePath)),
          );
        }
      }),
  );
});
