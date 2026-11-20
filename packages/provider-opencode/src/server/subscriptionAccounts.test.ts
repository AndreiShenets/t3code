import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readOpenCodeSubscriptionAccounts } from "./subscriptionAccounts.ts";

const accessToken = (email: string) =>
  `header.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/profile": { email },
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-1" },
    }),
  ).toString("base64url")}.signature`;

it.effect(
  "matches only the active OAuth user and workspace behind the effective OpenAI provider",
  () =>
    Effect.gen(function* () {
      const provider = {
        id: "work-openai",
        integrationID: "openai",
        settings: { baseURL: "https://chatgpt.com/backend-api/codex" },
        headers: { "chatgpt-account-id": "workspace-1" },
      };
      const credential = {
        integrationID: "openai",
        active: true,
        value: {
          type: "oauth",
          access: accessToken("person@example.com"),
          metadata: { accountID: "workspace-1" },
        },
      };
      const read = (providers: readonly unknown[], credentials: readonly unknown[]) =>
        readOpenCodeSubscriptionAccounts({ providers, credentials, environment: {} });

      NodeAssert.deepEqual(yield* read([provider], [credential]), [
        {
          modelProviderId: "work-openai",
          driver: "codex",
          email: "person@example.com",
          workspaceId: "workspace-1",
        },
      ]);
      for (const invalid of [
        { ...credential, active: false },
        { ...credential, value: { type: "key", key: "api-key" } },
        { ...credential, value: { ...credential.value, access: "opaque-token" } },
        {
          ...credential,
          value: { ...credential.value, metadata: { accountID: "other-workspace" } },
        },
      ]) {
        NodeAssert.deepEqual(yield* read([provider], [invalid]), []);
      }
      NodeAssert.deepEqual(
        yield* read(
          [{ ...provider, settings: { baseURL: "https://api.openai.com/v1" } }],
          [credential],
        ),
        [],
      );
      NodeAssert.deepEqual(yield* read([provider], [credential, credential]), []);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads Claude Agent's own login and rejects API, proxy, and cloud overrides", () =>
  Effect.gen(function* () {
    const provider = { id: "claude-agent", integrationID: "claude-agent", settings: {} };
    const credentials = [
      {
        integrationID: "claude-agent",
        active: true,
        value: { type: "external", methodID: "claude-login" },
      },
    ];
    const fs = FileSystem.makeNoop({
      readFileString: (path) =>
        Effect.succeed(
          path.endsWith(".credentials.json")
            ? JSON.stringify({ claudeAiOauth: { accessToken: "secret", subscriptionType: "max" } })
            : JSON.stringify({
                oauthAccount: {
                  accountUuid: "person-1",
                  organizationUuid: "org-1",
                  emailAddress: "person@example.com",
                },
              }),
        ),
    });
    const read = (settings: Record<string, string> = {}, environment: NodeJS.ProcessEnv = {}) =>
      readOpenCodeSubscriptionAccounts({
        providers: [{ ...provider, settings }],
        credentials,
        environment: { CLAUDE_CONFIG_DIR: "/claude-profile", ...environment },
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    NodeAssert.deepEqual(yield* read(), [
      {
        modelProviderId: "claude-agent",
        driver: "claudeAgent",
        email: "person@example.com",
        workspaceId: "org-1",
      },
    ]);
    const keychainAccount = yield* readOpenCodeSubscriptionAccounts({
      providers: [provider],
      credentials,
      environment: { CLAUDE_CONFIG_DIR: "/claude-profile" },
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            NodeAssert.ok(!path.endsWith(".credentials.json"));
            return Effect.succeed(
              JSON.stringify({
                oauthAccount: { emailAddress: "person@example.com", organizationUuid: "org-1" },
              }),
            );
          },
        }),
      ),
    );
    NodeAssert.deepEqual(keychainAccount, yield* read());
    for (const key of ["apiKey", "authToken", "baseURL"]) {
      NodeAssert.deepEqual(yield* read({ [key]: "override" }), []);
    }
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      NodeAssert.deepEqual(yield* read({}, { [key]: "override" }), []);
    }
    NodeAssert.deepEqual(
      yield* readOpenCodeSubscriptionAccounts({
        providers: [provider],
        credentials: [],
        environment: {},
      }),
      [],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
