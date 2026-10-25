import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import {
  changeRequestUrlBelow,
  defineSourceControl,
  remoteWebOrigin,
} from "@t3tools/source-control-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { definition as cloudDefinition } from "./definition.ts";

export const settings = makeProviderSettingsSchema({
  collectionUrl: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Collection URL",
      description: "Full HTTPS collection URL, including any installation path and port.",
    }),
  ),
  personalAccessToken: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Personal access token",
      description:
        "When provided, this token is always used instead of Windows credentials. Leave empty to use Windows sign-in. Required on macOS/Linux.",
      settingsSecret: true,
      providerSettingsForm: { control: "password" },
    }),
  ),
});
export type AzureDevOpsServerSettings = typeof settings.Type;

const KIND = SourceControlProviderKind.make("azure-devops-custom-server");

function isCustomUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (
      url.hostname === "dev.azure.com" ||
      url.hostname.endsWith(".dev.azure.com") ||
      url.hostname.endsWith(".visualstudio.com")
    )
      return false;
    return cloudDefinition.parseChangeRequestUrl(url) !== null;
  } catch {
    return false;
  }
}

export const definition = defineSourceControl({
  ...cloudDefinition,
  kind: KIND,
  label: "Azure DevOps Custom",
  pickerLabel: "Azure DevOps Custom",
  settings,
  publishDescription: "Repository publishing is not supported",
  publishHost: (signedInHost: string | null) => signedInHost ?? "your server",
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `pullrequest/${number}`)
      : `${remoteWebOrigin(host, remoteUrl)}/${repository}/pullrequest/${number}`,
  checkoutCommand: () => null,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: isCustomUrl,
  parseChangeRequestUrl: (url) =>
    isCustomUrl(url.href) ? cloudDefinition.parseChangeRequestUrl(url) : null,
  recognizeRemote: (remote) => {
    if (cloudDefinition.recognizeRemote(remote) !== null) return null;
    try {
      const url = new URL(remote.remoteUrl);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        /^\/(?:[^/]+\/)+_git\/[^/]+\/?$/iu.test(url.pathname.replace(/\.git$/iu, ""))
        ? { kind: KIND, name: "Azure DevOps Custom", baseUrl: url.origin }
        : null;
    } catch {
      return null;
    }
  },
  repositoryKeyFromRemote: (key, remoteUrl) => {
    if (!remoteUrl) return null;
    try {
      const url = new URL(remoteUrl);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        /\/_git\/[^/]+(?:\.git)?\/?$/iu.test(url.pathname) &&
        cloudDefinition.recognizeRemote({ remoteUrl, host: url.host, hostname: url.hostname }) === null
        ? `${url.host.toLowerCase()}/${key.split("/").slice(1).join("/")}`
        : null;
    } catch {
      return null;
    }
  },
  canonicalRepositoryKey: (key) =>
    /^[^/]+\/(?:[^/]+\/)+_git\/[^/]+$/iu.test(key) &&
    !cloudDefinition.canonicalRepositoryKey(key)
      ? key
      : null,
  changeRequestHost: (identity) => {
    try {
      const url = new URL(identity?.locator?.remoteUrl ?? "");
      if (url.protocol === "http:" || url.protocol === "https:") return url.host.toLowerCase();
    } catch {}
    return identity?.canonicalKey?.split("/")[0] ?? KIND;
  },
  isChangeRequestInRepository: (identity, link) =>
    identity.canonicalKey.toLowerCase() ===
    `${link.authority ?? link.host}/${link.repository}`.toLowerCase(),
  // URL shape is recognition, not permission to read another collection with this credential.
  canReadChangeRequestOnHost: () => false,
});
