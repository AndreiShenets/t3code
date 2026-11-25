import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";

const WEB_ICON_FILENAMES = [
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "icon-192x192.png",
  "icon-512x512.png",
];

it.layer(NodeServices.layer)("apply-web-brand-assets", (it) => {
  it.effect("copies the AS Code icons into an absolute target directory for every channel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const publicDirectory = yield* path.fromFileUrl(
        new URL("../apps/web/public", import.meta.url),
      );
      for (const brand of ["development", "nightly", "production"] as const) {
        const targetDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "apply-web-brand-assets-",
        });
        yield* applyWebBrandAssets(brand, targetDirectory);

        assert.deepStrictEqual(
          (yield* fs.readDirectory(targetDirectory)).toSorted(),
          WEB_ICON_FILENAMES,
        );
        for (const file of WEB_ICON_FILENAMES) {
          const actual = yield* fs.readFile(path.join(targetDirectory, file));
          const expected = yield* fs.readFile(path.join(publicDirectory, file));
          assert.isTrue(Buffer.from(actual).equals(expected), `${brand} ${file}`);
        }
      }
    }),
  );

  it.effect("resolves an empty target directory to the repo root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const destinations = WEB_ICON_FILENAMES.map((filename) => path.join(repoRoot, filename));
      // readDirectory does not follow symlinks, so a dangling link counts as an existing entry.
      // Names are lowercased so a case-insensitive filesystem cannot hide a differently cased file.
      const existingEntries = new Set(
        (yield* fs.readDirectory(repoRoot)).map((entry) => entry.toLowerCase()),
      );
      for (const destination of destinations) {
        assert.isFalse(
          existingEntries.has(path.basename(destination)),
          `${destination} already exists`,
        );
      }
      yield* Effect.addFinalizer(() =>
        Effect.forEach(destinations, (destination) => fs.remove(destination, { force: true })).pipe(
          Effect.orDie,
        ),
      );

      yield* applyWebBrandAssets("production", "");

      for (const destination of destinations) {
        assert.isTrue(yield* fs.exists(destination));
      }
    }),
  );
});
