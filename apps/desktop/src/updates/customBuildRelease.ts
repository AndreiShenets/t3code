import * as Schema from "effect/Schema";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

export const CUSTOM_BUILD_REPOSITORY = "AndreiShenets/t3code";

export function isNightlyNotNewerThanCustomBuild(
  version: string,
  releaseDate: unknown,
  customBuildTimestamp: string | null,
) {
  if (
    resolveDefaultDesktopUpdateChannel(version) !== "nightly" ||
    typeof releaseDate !== "string" ||
    !customBuildTimestamp
  ) {
    return false;
  }
  // The legacy local build stamp cannot be compared reliably after a timezone change.
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!hasTimezone.test(releaseDate) || !hasTimezone.test(customBuildTimestamp)) return false;
  const nightlyTime = Date.parse(releaseDate);
  const customTime = Date.parse(customBuildTimestamp);
  return Number.isFinite(nightlyTime) && Number.isFinite(customTime) && nightlyTime <= customTime;
}

export const CustomBuildReleases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        size: Schema.Number,
        browser_download_url: Schema.String,
      }),
    ),
  }),
);

export function selectCustomBuild(releases: typeof CustomBuildReleases.Type) {
  return (
    releases
      .flatMap((release) => {
        const match = /^as-custom-v(\d+\.\d+\.\d+)-(\d{12})$/.exec(release.tag_name);
        if (release.draft || !match) return [];
        const [, version, stamp] = match;
        const name = `T3-Code-AS-Custom-${version}-${stamp}-x64.exe`;
        const installer = release.assets.find((asset) => asset.name === name && asset.size > 0);
        const checksums = release.assets.find((asset) => asset.name === "SHA256SUMS");
        const prefix = `https://github.com/${CUSTOM_BUILD_REPOSITORY}/releases/download/${release.tag_name}/`;
        if (
          !installer ||
          !checksums ||
          installer.browser_download_url !== `${prefix}${name}` ||
          checksums.browser_download_url !== `${prefix}SHA256SUMS`
        ) {
          return [];
        }
        return [{ stamp: stamp!, label: `${version} ${stamp}`, installer, checksums }];
      })
      .toSorted((left, right) => right.stamp.localeCompare(left.stamp))[0] ?? null
  );
}

export function customBuildChecksum(text: string, name: string) {
  const entries = text
    .split(/\r?\n/)
    .map((line) => /^([a-f\d]{64}) [ *](.+)$/i.exec(line))
    .filter((match) => match?.[2] === name);
  return entries.length === 1 ? entries[0]![1]!.toLowerCase() : null;
}
