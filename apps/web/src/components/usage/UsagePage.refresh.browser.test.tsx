import { act, fakeTimers, render } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { Atom } from "effect/reactivity";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

type Presentations = ReadonlyMap<EnvironmentId, Record<string, unknown>>;
const state = vi.hoisted(() => ({
  presentations: null as unknown as Atom.Writable<Presentations>,
  refreshProviders: vi.fn<(input: unknown) => Promise<undefined>>(),
  usageWindow: null as UsageSummaryInput | null,
  refreshUsage: vi.fn<(input?: UsageSummaryInput) => Promise<undefined>>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
  useCanGoBack: () => false,
}));
// Real presentations come from live connections; these tests drive them directly.
vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const presentations = Atom.make<Presentations>(new Map()).pipe(Atom.keepAlive);
  state.presentations = presentations;
  const providers = Atom.make(
    (get) =>
      new Map(
        [...get(presentations)].map(([id, presentation]) => [
          id,
          (presentation.serverConfig as { providers: unknown }).providers,
        ]),
      ),
  );
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: presentations as never,
      presentationsWithProvidersAtom: presentations as never,
      providersByEnvironmentAtom: providers as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.refreshProviders) as never,
}));
vi.mock(import("../../state/usage"), async (original) => {
  const environment = {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: null,
  };
  return {
    ...(await original()),
    useUsage: ((window: UsageSummaryInput) => {
      state.usageWindow = window;
      return {
        merged: mergeUsage([], USAGE_CONTRACT_VERSION),
        environments: [environment],
        selectedEnvironments: [environment],
        isPending: false,
        shown: null,
        isPartial: false,
        refresh: state.refreshUsage,
      };
    }) as never,
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { UsagePage } from "./UsagePage";

const PREFERENCES_KEY = "t3code:usage-page-preferences:v1";
// Limits refreshes are throttled per environment for the whole session, so each test
// gets fresh environment ids.
let environmentNumber = 0;
let environmentId: EnvironmentId;

function presentation(phase = "connected") {
  return {
    entry: { target: { label: "Test" } },
    connection: { phase, error: null, traceId: null },
    serverConfig: {
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-11T12:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt: "2026-09-11T12:00:00Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 40,
                windowDurationMins: 300,
                resetsAt: "2026-09-11T14:00:00Z",
              },
            ],
          },
        },
      ],
    },
  };
}

const setPresentations = (entries: ReadonlyArray<readonly [EnvironmentId, object]>) =>
  act(async () => appAtomRegistry.set(state.presentations, new Map(entries) as Presentations));
const setNow = (iso: string) => vi.mocked(Date.now).mockReturnValue(Date.parse(iso));
const resetsIn = (countdown: string) =>
  page.getByRole("button", { name: `codex: 60% left, resets in ${countdown}`, exact: false });
const refreshButton = () => page.getByRole("button", { name: "Refresh limits" });
const selectMetric = (label: string) => userEvent.click(page.getByRole("button", { name: label }));

async function renderPage({ strict = false } = {}) {
  const content = (
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsagePage />
    </RegistryContext.Provider>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}

async function setup() {
  // The metric toggle and its refresh button only show on wide screens.
  await page.viewport(1440, 900);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  environmentNumber += 1;
  environmentId = EnvironmentId.make(`test-${environmentNumber}`);
  const previous = localStorage.getItem(PREFERENCES_KEY);
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ metric: "limits", windowDays: 30 }));
  state.refreshProviders.mockReset().mockResolvedValue(undefined);
  state.refreshUsage.mockReset().mockResolvedValue(undefined);
  state.usageWindow = null;
  await setPresentations([[environmentId, presentation()]]);
  return {
    [Symbol.dispose]() {
      now.mockRestore();
      if (previous === null) localStorage.removeItem(PREFERENCES_KEY);
      else localStorage.setItem(PREFERENCES_KEY, previous);
      appAtomRegistry.set(state.presentations, new Map());
    },
  };
}

function mockDate(date: Date) {
  const timers = fakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(date);
  return timers;
}

it.each([
  ["wide", 1440],
  ["compact", 800],
] as const)("selects Today from the %s period control", async (layout, width) => {
  using _state = await setup();
  await page.viewport(width, 900);
  using _date = mockDate(new Date(2026, 7, 11, 12, 37));
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ metric: "tokens", windowDays: 30 }));
  await using _screen = await renderPage();
  if (layout === "wide") {
    await userEvent.click(page.getByRole("button", { name: "Today", exact: true }));
  } else {
    await userEvent.click(page.getByRole("combobox", { name: "Usage period" }));
    await userEvent.click(page.getByRole("option", { name: "Today", exact: true }));
  }
  expect(state.usageWindow).toMatchObject({
    sinceDay: "2026-08-11",
    untilDay: "2026-08-11",
    resolution: "hour",
    sinceTime: new Date(2026, 7, 11).toISOString(),
    untilTime: new Date(2026, 7, 11, 12, 37).toISOString(),
  });
});

it("restores Today and refreshes it against the new day after midnight", async () => {
  using _state = await setup();
  using _date = mockDate(new Date(2026, 7, 11, 23, 59));
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ metric: "tokens", windowDays: "today" }));
  await using _screen = await renderPage();
  expect(state.usageWindow).toMatchObject({
    sinceDay: "2026-08-11",
    untilDay: "2026-08-11",
    resolution: "hour",
    sinceTime: new Date(2026, 7, 11).toISOString(),
    untilTime: new Date(2026, 7, 11, 23, 59).toISOString(),
  });
  vi.setSystemTime(new Date(2026, 7, 12, 0, 1));
  await userEvent.click(page.getByRole("button", { name: "Refresh usage" }));
  expect(state.refreshUsage).toHaveBeenCalledWith(
    expect.objectContaining({
      sinceDay: "2026-08-12",
      untilDay: "2026-08-12",
      resolution: "hour",
      sinceTime: new Date(2026, 7, 12).toISOString(),
      untilTime: new Date(2026, 7, 12, 0, 1).toISOString(),
    }),
  );
  expect(state.usageWindow?.sinceDay).toBe("2026-08-12");
});

it.each([
  ["wide", 1440],
  ["compact", 800],
])(
  "refreshes the visible limits countdown from the %s toolbar without switching tabs, even when quota is unchanged",
  async (_layout, width) => {
    using _state = await setup();
    await page.viewport(width, 900);
    await using _screen = await renderPage();
    await expect.element(resetsIn("2h 0m")).toBeVisible();
    setNow("2026-09-11T12:30:00Z");

    await userEvent.click(refreshButton());

    expect(state.refreshProviders).toHaveBeenCalledWith({ environmentId, input: {} });
    await expect.element(resetsIn("1h 30m")).toBeVisible();
    await expect.element(resetsIn("2h 0m")).not.toBeInTheDocument();
  },
);

it("uses the current time when returning to limits from tokens", async () => {
  using _state = await setup();
  await using _screen = await renderPage();
  await selectMetric("Tokens");
  setNow("2026-09-11T13:00:00Z");
  await selectMetric("Limits");

  await expect.element(resetsIn("1h 0m")).toBeVisible();
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});

it("refreshes once on opening Limits and suppresses rapid returns and remounts", async () => {
  using _state = await setup();
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ metric: "tokens", windowDays: 30 }));
  await using screen = await renderPage({ strict: true });
  expect(state.refreshProviders).not.toHaveBeenCalled();

  await selectMetric("Limits");
  await vi.waitFor(() => expect(state.refreshProviders).toHaveBeenCalledTimes(1));
  await selectMetric("Tokens");
  await selectMetric("Limits");
  await screen.unmount();
  await using _remounted = await renderPage({ strict: true });
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);

  await selectMetric("Tokens");
  setNow("2026-09-11T12:05:00Z");
  await selectMetric("Limits");
  await vi.waitFor(() => expect(state.refreshProviders).toHaveBeenCalledTimes(2));
});

it("waits for connection and refreshes new environments during a slow refresh", async () => {
  using _state = await setup();
  await setPresentations([[environmentId, presentation("disconnected")]]);
  await using _screen = await renderPage();
  expect(state.refreshProviders).not.toHaveBeenCalled();

  let finishRefresh!: () => void;
  state.refreshProviders.mockImplementationOnce(
    () => new Promise((resolve) => (finishRefresh = () => resolve(undefined))),
  );
  await setPresentations([[environmentId, presentation()]]);
  await vi.waitFor(() => expect(state.refreshProviders).toHaveBeenCalledTimes(1));

  const nextId = EnvironmentId.make(`${environmentId}-next`);
  await setPresentations([
    [environmentId, presentation()],
    [nextId, presentation()],
  ]);
  await vi.waitFor(() => expect(state.refreshProviders).toHaveBeenCalledTimes(2));
  expect(state.refreshProviders).toHaveBeenLastCalledWith({ environmentId: nextId, input: {} });
  await act(async () => finishRefresh());
});

it("keeps manual refresh busy until the already-running automatic check settles", async () => {
  using _state = await setup();
  let finishRefresh!: () => void;
  state.refreshProviders.mockImplementationOnce(
    () => new Promise((resolve) => (finishRefresh = () => resolve(undefined))),
  );
  await using _screen = await renderPage();
  await vi.waitFor(() => expect(state.refreshProviders).toHaveBeenCalledTimes(1));

  await userEvent.click(refreshButton());
  await expect.element(refreshButton()).toHaveAttribute("aria-busy", "true");
  await expect.element(refreshButton()).toBeDisabled();
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);

  await act(async () => finishRefresh());
  await expect.element(refreshButton()).toHaveAttribute("aria-busy", "false");
});
