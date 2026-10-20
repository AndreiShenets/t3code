import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { defineSourceControlClient } from "@t3tools/source-control-core/client/definition";
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
    return (
      /\/_git\/[^/]+\/pullrequest\/\d+(?:\/|$)/iu.test(url.pathname) &&
      parseChangeRequestUrl(input) !== null
    );
  } catch {
    return false;
  }
}

export const definition = defineSourceControlClient({
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
      ? `${webUrl.replace(/\/+$/u, "")}/pullrequest/${number}`
      : changeRequestUrlFor(KIND, host, repository, number, remoteUrl),
  checkoutCommand: () => null,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: isCustomUrl,
  isChangeRequestUrl: isCustomUrl,
  changeRequestUrlHost: (url) => url.host,
  isChangeRequestInRepository: (identity, link) =>
    identity.canonicalKey.toLowerCase() ===
    `${link.authority ?? link.host}/${link.repository}`.toLowerCase(),
  // URL shape is recognition, not permission to read another collection with this credential.
  canReadChangeRequestOnHost: () => false,
});
