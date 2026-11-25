#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

class AsCodeIconRenderError extends Schema.TaggedError<AsCodeIconRenderError>()(
  "AsCodeIconRenderError",
  { output: Schema.String, cause: Schema.Defect() },
) {}

const exportAsCodeIcons = Effect.fn("exportAsCodeIcons")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const svg = Buffer.from(yield* fs.readFile(path.join(root, "assets/as-code/icon.svg")));
  const render = (size: number) =>
    Effect.tryPromise({
      try: () => sharp(svg, { density: 288 }).resize(size, size).png().toBuffer(),
      catch: (cause) => new AsCodeIconRenderError({ output: `${size}×${size}`, cause }),
    });
  const write = (file: string, contents: Uint8Array) =>
    fs.writeFile(path.join(root, file), contents);
  const windows = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    render(size).pipe(Effect.map((contents) => ({ size, contents }))),
  );
  yield* write("apps/web/public/favicon.ico", encodePngIco(windows));
  for (const [file, size] of [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192x192.png", 192],
    ["icon-512x512.png", 512],
  ] as const) {
    yield* write(`apps/web/public/${file}`, yield* render(size));
  }
  yield* write("assets/as-code/icon-1024.png", yield* render(1024));
  const macIcon = yield* render(824);
  yield* write(
    "assets/as-code/icon-macos-1024.png",
    yield* Effect.tryPromise({
      try: () =>
        sharp(macIcon)
          .extend({ top: 100, right: 100, bottom: 100, left: 100, background: "#0000" })
          .png()
          .toBuffer(),
      catch: (cause) => new AsCodeIconRenderError({ output: "macOS padding", cause }),
    }),
  );
});

const command = Command.make("export-as-code-icons", {}, exportAsCodeIcons);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
