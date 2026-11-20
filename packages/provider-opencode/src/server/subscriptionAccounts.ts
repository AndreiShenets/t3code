import { ProviderDriverKind, type ServerProviderWorkspaceSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

const Provider = Schema.Struct({
  id: Schema.String,
  integrationID: Schema.optional(Schema.String),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Credential = Schema.Struct({
  integrationID: Schema.String,
  active: Schema.Boolean,
  value: Schema.Struct({
    type: Schema.String,
    methodID: Schema.optional(Schema.String),
    access: Schema.optional(Schema.String),
    metadata: Schema.optional(Schema.Struct({ accountID: Schema.optional(Schema.String) })),
  }),
});
const Claims = Schema.Struct({
  "https://api.openai.com/profile": Schema.Struct({ email: Schema.NonEmptyString }),
  "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.NonEmptyString }),
});
const ClaudeAccount = Schema.Struct({
  oauthAccount: Schema.Struct({
    emailAddress: Schema.NonEmptyString,
    organizationUuid: Schema.NonEmptyString,
  }),
});
const ClaudeCredential = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.NonEmptyString,
    subscriptionType: Schema.NonEmptyString,
  }),
});
const decodeProvider = Schema.decodeUnknownOption(Provider);
const decodeCredential = Schema.decodeUnknownOption(Credential);
const decodeClaims = Schema.decodeOption(Schema.fromJsonString(Claims));
const decodeClaudeAccount = Schema.decodeEffect(Schema.fromJsonString(ClaudeAccount));
const decodeClaudeCredential = Schema.decodeEffect(Schema.fromJsonString(ClaudeCredential));

const CLAUDE_AUTH_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
];

const readClaudeAccount = Effect.fn("OpenCode.readClaudeSubscriptionAccount")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const accountPath = environment.CLAUDE_CONFIG_DIR?.trim()
    ? path.join(configDir, ".claude.json")
    : path.join(home, ".claude.json");
  const account = yield* fs.readFileString(accountPath).pipe(Effect.flatMap(decodeClaudeAccount));
  // Claude Code keeps its OAuth credential in the Keychain on macOS.
  if ((yield* HostProcess.Platform) !== "darwin") {
    yield* fs
      .readFileString(path.join(configDir, ".credentials.json"))
      .pipe(Effect.flatMap(decodeClaudeCredential));
  }
  return {
    email: account.oauthAccount.emailAddress.trim(),
    workspaceId: account.oauthAccount.organizationUuid.trim(),
  };
}, Effect.option);

export const readOpenCodeSubscriptionAccounts = Effect.fn("OpenCode.readSubscriptionAccounts")(
  function* (input: {
    readonly providers: readonly unknown[];
    readonly credentials: readonly unknown[];
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const providers = input.providers.flatMap((provider) =>
      Option.toArray(decodeProvider(provider)),
    );
    const credentials = input.credentials
      .flatMap((credential) => Option.toArray(decodeCredential(credential)))
      .filter((credential) => credential.active);
    const accounts: NonNullable<ServerProviderWorkspaceSnapshot["subscriptionAccounts"]>[number][] =
      [];
    for (const provider of providers) {
      const matching = credentials.filter(
        (credential) => credential.integrationID === provider.integrationID,
      );
      if (matching.length !== 1) continue;
      const credential = matching[0]!.value;
      if (provider.integrationID === "openai" && credential.type === "oauth") {
        if (provider.settings?.baseURL !== "https://chatgpt.com/backend-api/codex") continue;
        if (
          ["apiKey", "authToken"].some((key) => provider.settings?.[key]) ||
          Object.keys(provider.headers ?? {}).some((key) => /authorization|api-key/i.test(key))
        )
          continue;
        const tokenBody = credential.access?.split(".")[1];
        if (!tokenBody) continue;
        const claims = decodeClaims(Buffer.from(tokenBody, "base64url").toString("utf8"));
        if (Option.isNone(claims)) continue;
        const workspaceId = claims.value["https://api.openai.com/auth"].chatgpt_account_id.trim();
        const email = claims.value["https://api.openai.com/profile"].email.trim();
        if (
          !email ||
          !workspaceId ||
          credential.metadata?.accountID !== workspaceId ||
          provider.headers?.["chatgpt-account-id"] !== workspaceId
        )
          continue;
        accounts.push({
          modelProviderId: provider.id,
          driver: ProviderDriverKind.make("codex"),
          email,
          workspaceId,
        });
      } else if (
        provider.integrationID === "claude-agent" &&
        credential.type === "external" &&
        credential.methodID === "claude-login" &&
        !CLAUDE_AUTH_OVERRIDES.some((key) => input.environment[key]?.trim()) &&
        !["apiKey", "authToken", "baseURL"].some((key) => provider.settings?.[key]) &&
        !Object.keys(provider.headers ?? {}).some((key) => /authorization|api-key/i.test(key))
      ) {
        const account = yield* readClaudeAccount(input.environment);
        if (Option.isSome(account) && account.value.email && account.value.workspaceId) {
          accounts.push({
            modelProviderId: provider.id,
            driver: ProviderDriverKind.make("claudeAgent"),
            ...account.value,
          });
        }
      }
    }
    return accounts;
  },
);
