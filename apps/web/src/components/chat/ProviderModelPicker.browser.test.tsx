import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ModelSelection,
} from "@t3tools/contracts";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render as renderUi } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

const favoritesAtom = Atom.make<ReadonlyArray<{ provider: ProviderInstanceId; model: string }>>(
  [],
).pipe(Atom.keepAlive);

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({
    favorites: useAtomValue(favoritesAtom),
    providerModelPreferences: {},
  }),
  useToggleEnvironmentModelFavorite: () => {
    const setFavorites = useAtomSet(favoritesAtom);
    return async (provider: ProviderInstanceId, model: string) => {
      setFavorites((favorites) =>
        favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model),
      );
    };
  },
}));

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

// Returns the trigger's visible text, which is what the user reads before opening the picker.
async function triggerText(node: ReactNode) {
  await using screen = await renderUi(node);
  return screen.container.querySelector("button")?.textContent ?? "";
}

function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  triggerLabel?: string;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver);
  return triggerText(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      onInstanceModelChange={() => {}}
      {...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {})}
    />,
  );
}

async function click(target: Parameters<typeof userEvent.click>[0]) {
  await userEvent.click(target);
}

async function openLegacyPicker(activeModel: string) {
  const entry = providerEntry("codex", "codex");
  await using stack = new AsyncDisposableStack();
  const pickerRegistry = AtomRegistry.make();
  stack.defer(() => pickerRegistry.dispose());
  pickerRegistry.set(favoritesAtom, [
    { provider: entry.instanceId, model: "current-favorite" },
    { provider: entry.instanceId, model: "legacy-favorite" },
  ]);
  stack.use(
    await renderUi(
      <RegistryContext.Provider value={pickerRegistry!}>
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={entry.instanceId}
          model={activeModel}
          lockedProvider={null}
          instanceEntries={[entry]}
          modelOptionsByInstance={
            new Map([
              [
                entry.instanceId,
                [
                  { slug: "current", name: "Current model" },
                  { slug: "legacy-favorite", name: "Legacy favorite", isLegacy: true },
                  { slug: "current-favorite", name: "Current favorite" },
                  { slug: "other-legacy", name: "Other legacy", isLegacy: true },
                ],
              ],
            ])
          }
          onInstanceModelChange={() => {}}
        />
      </RegistryContext.Provider>,
    ),
  );
  await click(document.querySelector("button")!);
  await click(page.getByRole("button", { name: entry.displayName, exact: true }));
  return stack.move();
}

describe("ProviderModelPicker", () => {
  it("hoists legacy favorites in provider order and returns an unfavorited model to legacy", async () => {
    await using _screen = await openLegacyPicker("current");
    const legacyFavorite = page.getByRole("option", { name: /Legacy favorite/ });
    const currentFavorite = page.getByRole("option", { name: /Current favorite/ });
    const current = page.getByRole("option", { name: /Current model/ });
    const legacySection = page.getByRole("option", { name: /Legacy models/ });

    await expect.element(legacyFavorite).toBeVisible();
    await expect.element(currentFavorite).toBeVisible();
    await expect.element(current).toBeVisible();
    expect(legacyFavorite.element().getBoundingClientRect().top).toBeLessThan(
      currentFavorite.element().getBoundingClientRect().top,
    );
    expect(currentFavorite.element().getBoundingClientRect().top).toBeLessThan(
      current.element().getBoundingClientRect().top,
    );

    await click(legacyFavorite.getByRole("button", { name: "Remove from favorites" }));
    await expect.element(legacyFavorite).not.toBeInTheDocument();
    await click(legacySection);
    await expect.element(legacyFavorite).toBeVisible();
    await expect.element(page.getByRole("option", { name: /Other legacy/ })).toBeVisible();
    expect(legacyFavorite.element().getBoundingClientRect().top).toBeGreaterThan(
      legacySection.element().getBoundingClientRect().top,
    );
    await expect
      .element(legacyFavorite.getByRole("button", { name: "Add to favorites" }))
      .toBeVisible();
  });

  it("keeps unrelated legacy models collapsed when the active model is a favorite", async () => {
    await using _screen = await openLegacyPicker("legacy-favorite");

    await expect.element(page.getByRole("option", { name: /Legacy favorite/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /Other legacy/ }))
      .not.toBeInTheDocument();
    await click(page.getByRole("option", { name: /Legacy models/ }));
    await expect.element(page.getByRole("option", { name: /Other legacy/ })).toBeVisible();
  });

  it("shows a neutral aggregate value without a representative model or availability badge", async () => {
    const label = await renderPicker({
      instanceId: "codex_personal",
      driver: "codex",
      model: "gpt-5",
      options: [{ slug: "gpt-5", name: "GPT 5", isUnavailable: true }],
      triggerLabel: "Mixed values",
    });
    expect(label).toContain("Mixed values");
    expect(label).not.toContain("GPT 5");
    expect(label).not.toContain("Unavailable");
    expect(label).not.toContain("Codex");
  });

  it.each(["OpenAI", "GitHub Copilot"])(
    "shows the selected OpenCode model's %s provider beneath its name",
    async (subProvider) => {
      const label = await renderPicker({
        instanceId: "opencode",
        driver: "opencode",
        model: "selected/model",
        options: [{ slug: "selected/model", name: "Selected model", subProvider }],
      });

      expect(label).toContain(`Selected modelOpenCode · ${subProvider}`);
    },
  );

  it("shows the provider instance name when there is no upstream provider", async () => {
    const label = await renderPicker({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      model: "selected",
      options: [{ slug: "selected", name: "Selected model" }],
    });

    expect(label).toContain("Selected modelClaude");
  });

  it.each(["sm", "xs"] as const)(
    "centers the smaller provider subtitle inside the %s trigger without growing the control",
    async (size) => {
      const entry = providerEntry("opencode", "opencode");
      await using _screen = await renderUi(
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={entry.instanceId}
          model="openai/model"
          lockedProvider={null}
          instanceEntries={[entry]}
          modelOptionsByInstance={
            new Map([
              [
                entry.instanceId,
                [{ slug: "openai/model", name: "GPT-6.1 Sol", subProvider: "GitHub Copilot" }],
              ],
            ])
          }
          size={size}
          onInstanceModelChange={() => {}}
        />,
      );

      const trigger = page.getByRole("button", {
        name: "GPT-6.1 Sol (OpenCode · GitHub Copilot)",
      });
      const model = trigger.getByText("GPT-6.1 Sol", { exact: true });
      const provider = trigger.getByText("OpenCode · GitHub Copilot", { exact: true });
      await expect.element(model).toBeVisible();
      await expect.element(provider).toBeVisible();
      const triggerBounds = trigger.element().getBoundingClientRect();
      const modelBounds = model.element().getBoundingClientRect();
      const providerBounds = provider.element().getBoundingClientRect();
      expect(triggerBounds.height).toBeLessThanOrEqual(28);
      expect(modelBounds.top).toBeGreaterThanOrEqual(triggerBounds.top);
      expect(providerBounds.top).toBeGreaterThanOrEqual(modelBounds.bottom);
      expect(providerBounds.bottom).toBeLessThanOrEqual(triggerBounds.bottom);
      expect(Number.parseFloat(getComputedStyle(provider.element()).fontSize)).toBe(6);
      const modelText = document.createRange();
      modelText.selectNodeContents(model.element());
      const providerText = document.createRange();
      providerText.selectNodeContents(provider.element());
      const modelTextBounds = modelText.getBoundingClientRect();
      const providerTextBounds = providerText.getBoundingClientRect();
      expect(
        Math.abs(
          modelTextBounds.left +
            modelTextBounds.width / 2 -
            (providerTextBounds.left + providerTextBounds.width / 2),
        ),
      ).toBeLessThan(1);
    },
  );

  it("includes both upstream providers when selecting the same model through different providers", async () => {
    const entry = providerEntry("opencode", "opencode");
    const label = await triggerText(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={entry.instanceId}
        model="openai/model"
        selectedModels={[
          { instanceId: entry.instanceId, model: "openai/model" },
          { instanceId: entry.instanceId, model: "github-copilot/model" },
        ]}
        lockedProvider={null}
        instanceEntries={[entry]}
        modelOptionsByInstance={
          new Map([
            [
              entry.instanceId,
              [
                { slug: "openai/model", name: "Same model", subProvider: "OpenAI" },
                {
                  slug: "github-copilot/model",
                  name: "Same model",
                  subProvider: "GitHub Copilot",
                },
              ],
            ],
          ])
        }
        onInstanceModelChange={() => {}}
      />,
    );

    expect(label).toContain("Same model, Same model");
    expect(label).toContain("OpenCode · OpenAI, OpenCode · GitHub Copilot");
  });

  it.each(["", ANTIGRAVITY_DEFAULT_MODEL])(
    "shows a choice prompt before Antigravity has an account catalog for %s",
    async (model) => {
      const label = await renderPicker({
        instanceId: "antigravity",
        driver: "antigravity",
        model,
        options: [],
      });

      expect(label).toContain("Choose model");
      expect(label).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each([{ aliases: [ANTIGRAVITY_DEFAULT_MODEL] }, { isDefault: true }])(
    "shows the actual default model for an Antigravity marker with %j",
    async (defaultMetadata) => {
      const label = await renderPicker({
        instanceId: "google_work",
        driver: "antigravity",
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [
          { slug: "gemini-fast", name: "Gemini Fast" },
          { slug: "gemini-pro", name: "Gemini Pro", ...defaultMetadata },
        ],
      });

      expect(label).toContain("Gemini Pro");
      expect(label).not.toContain("Gemini Fast");
      expect(label).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each(["opencode", "antigravity"])(
    "keeps the selected model label when the %s account catalog does not contain it",
    async (driver) => {
      const label = await renderPicker({
        instanceId: "team_runtime",
        driver,
        model: "missing-model",
        options: [{ slug: "fallback", name: "Fallback model" }],
      });

      expect(label).toContain("missing-model");
      expect(label).not.toContain("Fallback model");
    },
  );

  it.each(["codex", "claudeAgent", "cursor", "grok"])(
    "uses the first option label for a missing %s model",
    async (driver) => {
      const label = await renderPicker({
        instanceId: `${driver}_work`,
        driver,
        model: "missing-model",
        options: [{ slug: "fallback-model", name: "Fallback model" }],
      });

      expect(label).toContain("Fallback model");
      expect(label).not.toContain("missing-model");
    },
  );

  it("prefers a matching model for OpenCode", async () => {
    const label = await renderPicker({
      instanceId: "custom_runtime",
      driver: "opencode",
      model: "openrouter/selected",
      options: [
        { slug: "openrouter/fallback", name: "Fallback model" },
        { slug: "openrouter/selected", name: "Selected model" },
      ],
    });

    expect(label).toContain("Selected model");
    expect(label).not.toContain("Fallback model");
  });

  it("uses the first option when the active instance entry is missing", async () => {
    const label = await renderPicker({
      instanceId: "missing_instance",
      driver: "opencode",
      model: "missing-model",
      options: [{ slug: "fallback-model", name: "Fallback model" }],
      includeEntry: false,
    });

    expect(label).toContain("Fallback model");
    expect(label).not.toContain("missing-model");
  });

  it("keeps instance initials visible in the resting trigger", async () => {
    const activeEntry = providerEntry("codex_personal", "codex");
    const label = await triggerText(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={activeEntry.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={[providerEntry("codex", "codex"), activeEntry]}
        modelOptionsByInstance={new Map()}
        size="xs"
        onInstanceModelChange={() => {}}
      />,
    );

    expect(label).toContain("CP");
  });
});

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await renderUi(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model (First agent)", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await renderUi(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await expect.element(search).not.toBeInTheDocument();
});
