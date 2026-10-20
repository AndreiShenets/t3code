import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  saved: undefined as Record<string, unknown> | undefined,
  save: vi.fn(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => state.saved) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => state.save,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

import { SourceControlHostSettings } from "./SourceControlHostSettings";

const kind = "azure-devops-custom-server";
const definition = sourceControlClients.find(kind)!;
const decodeCustomSettings = Schema.decodeUnknownSync(definition.settings!);
const collectionUrl = "https://ado.example/Collection";
let root: Root;
let container: HTMLDivElement;

const render = () =>
  act(async () =>
    root.render(
      <SourceControlHostSettings
        environmentId={EnvironmentId.make("test-environment")}
        definition={{ ...definition, settings: definition.settings! }}
        onSaved={() => undefined}
      />,
    ),
  );

const input = () => page.getByRole("textbox", { name: "Collection URL", exact: true });
const inputValue = () => (input().element() as HTMLInputElement).value;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.saved = undefined;
  state.save.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps the collection visible while saving and before the settings stream catches up", async () => {
  const result = AsyncResult.success({
    ...DEFAULT_SERVER_SETTINGS,
    sourceControlHosts: { [kind]: { collectionUrl } },
  });
  let finish!: (value: typeof result) => void;
  state.save.mockReturnValue(
    new Promise<typeof result>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => {
    await userEvent.fill(input(), collectionUrl);
    await userEvent.tab();
  });
  expect(inputValue()).toBe(collectionUrl);
  state.saved = { personalAccessToken: "" };
  await render();
  expect(inputValue()).toBe(collectionUrl);
  await act(async () => finish(result));
  expect(inputValue()).toBe(collectionUrl);
  state.saved = { collectionUrl };
  await render();
  expect(inputValue()).toBe(collectionUrl);
  state.saved = { collectionUrl: "https://ado.example/Changed-on-another-device" };
  await render();
  expect(inputValue()).toBe(state.saved.collectionUrl);
  state.saved = undefined;
  await render();
  expect(inputValue()).toBe("");
});

it("restores the saved collection when an edit fails to save", async () => {
  state.saved = { collectionUrl };
  let fail!: () => void;
  state.save.mockReturnValue(
    new Promise((resolve) => {
      fail = () => resolve(AsyncResult.fail("settings unavailable"));
    }),
  );
  await render();
  await act(async () => {
    await userEvent.fill(input(), "https://ado.example/Other");
    await userEvent.tab();
  });
  expect(inputValue()).toBe("https://ado.example/Other");
  await act(async () => fail());
  expect(inputValue()).toBe(collectionUrl);
});

it("does not offer a mode selector, including for legacy PAT-only settings", async () => {
  state.saved = { collectionUrl, authentication: "pat" };
  state.save.mockImplementation(async ({ input: { patch } }) => {
    state.saved = { ...state.saved, ...patch.sourceControlHosts[kind] };
    return AsyncResult.success({ sourceControlHosts: { [kind]: state.saved } });
  });
  await render();
  const decoded = decodeCustomSettings(state.saved);
  expect(decoded).toEqual({ collectionUrl, personalAccessToken: "" });
  await expect
    .element(page.getByRole("combobox", { name: "Authentication", exact: true }))
    .not.toBeInTheDocument();
});

it("does not resend a secret when editing another field before the settings stream catches up", async () => {
  state.saved = { collectionUrl };
  let call = 0;
  state.save.mockImplementation(async ({ input: { patch } }) => {
    const fields = patch.sourceControlHosts[kind];
    call++;
    if (call === 1) {
      expect(fields.personalAccessToken).toBe("replacement-token");
      return AsyncResult.success({
        sourceControlHosts: {
          [kind]: { collectionUrl, personalAccessToken: "••••••" },
        },
      });
    }
    expect(fields).toEqual({ collectionUrl: "https://ado.example/Other" });
    return AsyncResult.success({
      sourceControlHosts: {
        [kind]: { ...fields, personalAccessToken: "••••••" },
      },
    });
  });
  await render();
  const token = page.getByLabelText("Personal access token", { exact: true });
  await act(async () => {
    await userEvent.fill(token, "replacement-token");
    await userEvent.tab();
  });
  expect((token.element() as HTMLInputElement).value).toBe("");
  await act(async () => {
    await userEvent.fill(input(), "https://ado.example/Other");
    await userEvent.tab();
  });
  expect(inputValue()).toBe("https://ado.example/Other");
  expect(call).toBe(2);
});

it("clears the host settings without retaining an authentication mode", async () => {
  state.saved = { collectionUrl, authentication: "pat", personalAccessToken: "••••••" };
  state.save.mockImplementation(async ({ input: { patch } }) => {
    state.saved = { ...state.saved, ...patch.sourceControlHosts[kind] };
    return AsyncResult.success({ sourceControlHosts: { [kind]: state.saved } });
  });
  await render();
  await act(async () => page.getByRole("button", { name: "Remove", exact: true }).click());
  expect(inputValue()).toBe("");
  expect(decodeCustomSettings(state.saved)).toMatchObject({
    collectionUrl: "",
    personalAccessToken: "",
  });
  await expect
    .element(page.getByRole("button", { name: "Remove", exact: true }))
    .not.toBeInTheDocument();
});
