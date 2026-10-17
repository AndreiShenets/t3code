import * as Schema from "effect/Schema";

export const CUSTOM_BUILD_REPOSITORY = "AndreiShenets/t3code";

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
