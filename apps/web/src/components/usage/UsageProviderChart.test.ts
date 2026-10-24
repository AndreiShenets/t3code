import { describe, expect, it } from "vite-plus/test";

import { buildChart, buildPeriodColumns } from "./UsageProviderChart";
import { enumerateDays, enumerateHourStarts, makeWindow } from "@t3tools/shared/usageFormat";
import { providersWithUsage } from "./usageProviders";
import { usageSeriesKey } from "@t3tools/shared/usageSeries";

describe("single-period chart", () => {
  it.each(["cost", "tokens"] as const)(
    "draws separate upstream %s paths and tooltip values",
    (metric) => {
      const series = [
        { provider: "opencode" as const, upstreamProvider: "openai" },
        { provider: "opencode" as const, upstreamProvider: "github-copilot" },
      ];
      const day = "2026-10-20";
      const byPeriod = new Map([
        [
          day,
          {
            day,
            costUsd: 12,
            totalTokens: 120,
            byProvider: new Map([["opencode" as const, { costUsd: 12, totalTokens: 120 }]]),
            bySeries: new Map([
              [usageSeriesKey(series[0]!), { costUsd: 10, totalTokens: 100 }],
              [usageSeriesKey(series[1]!), { costUsd: 2, totalTokens: 20 }],
            ]),
          },
        ],
      ]);
      const chart = buildChart(
        [day],
        byPeriod,
        metric,
        ["opencode"],
        new Set(["opencode"]),
        series,
      );
      expect(chart.paths.map((path) => path.total)).toEqual(
        metric === "cost" ? [10, 2] : [100, 20],
      );
      expect(chart.paths[0]?.line).not.toBe(chart.paths[1]?.line);
      expect(chart.paths.every((path) => path.loading)).toBe(true);
      expect(chart.columns[0]?.total).toBe(metric === "cost" ? 12 : 120);
      expect(chart.columns[0]?.bands.map(usageSeriesKey)).toEqual(series.map(usageSeriesKey));
    },
  );

  it.each(["cost", "tokens"] as const)(
    "draws a single bucket's nonzero %s across the plot",
    (metric) => {
      const window = makeWindow("today", new Date("2026-10-17T12:00:00Z"), "day");
      const periods = enumerateDays(window.sinceDay, window.untilDay);
      const totals = {
        day: window.sinceDay,
        costUsd: 21.53,
        totalTokens: 114_000_000,
        byProvider: new Map([["opencode" as const, { costUsd: 21.53, totalTokens: 114_000_000 }]]),
      };
      const { paths, scale } = buildChart(
        periods,
        new Map([[window.sinceDay, totals]]),
        metric,
        ["opencode"],
        new Set(),
      );
      const value = metric === "cost" ? totals.costUsd : totals.totalTokens;
      const y = (260 - (value / scale.max) * 252).toFixed(2);

      expect(paths[0]?.line).toMatch(new RegExp(`^M0\\.00,${y} C.* 960\\.00,${y}$`));
      expect(paths[0]?.area).toBe(`${paths[0]?.line} L960,260 L0,260 Z`);
      expect(paths[0]?.total).toBe(value);
    },
  );

  it("leaves an empty window without a series", () => {
    const { paths } = buildChart([], new Map(), "cost", ["opencode"], new Set());

    expect(paths[0]).toMatchObject({ line: "", area: "", total: 0 });
  });

  it("preserves changing values in multi-period charts", () => {
    const periods = ["2026-10-16", "2026-10-17"];
    const byPeriod = new Map(
      periods.map((day, index) => [
        day,
        {
          day,
          costUsd: index * 20,
          totalTokens: 0,
          byProvider: new Map([["opencode" as const, { costUsd: index * 20, totalTokens: 0 }]]),
        },
      ]),
    );
    const { paths } = buildChart(periods, byPeriod, "cost", ["opencode"], new Set());

    expect(paths[0]?.line).toBe("M0.00,260.00 C320.00,176.00 640.00,92.00 960.00,8.00");
    expect(paths[0]?.total).toBe(20);
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("plots each day on its own", () => {
    expect(buildPeriodColumns(days, byDay, "cost").map((column) => column.total)).toEqual([
      35, 0, 5,
    ]);
  });

  it("reads the requested metric", () => {
    expect(buildPeriodColumns(days, byDay, "tokens").map((column) => column.total)).toEqual([
      350, 0, 50,
    ]);
  });

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
      { provider: "pi", value: 5 },
      { provider: "muse", value: 7 },
    ]);
  });

  it("reports the total as the sum of its bands", () => {
    for (const column of buildPeriodColumns(days, byDay, "cost")) {
      const sum = column.bands.reduce((running, band) => running + band.value, 0);
      expect(column.total).toBeCloseTo(sum, 9);
    }
  });
});

describe("providersWithUsage", () => {
  it("omits providers with no cost or tokens", () => {
    expect(
      providersWithUsage([
        { provider: "codex", costUsd: 0, totalTokens: 0 },
        { provider: "claude", costUsd: 0, totalTokens: 200 },
      ]),
    ).toEqual(["claude"]);
  });
});

describe("hourly chart columns", () => {
  it.each(["cost", "tokens"] as const)(
    "plots Today's varying hourly %s, including the partial hour",
    (metric) => {
      const window = makeWindow("today", new Date(2026, 9, 17, 12, 37));
      const periods = enumerateHourStarts(window.sinceTime ?? "", window.untilTime ?? "");
      const byPeriod = new Map(
        periods.map((hourStart, index) => [
          hourStart,
          {
            day: window.sinceDay,
            hourStart,
            costUsd: index,
            totalTokens: index * 100,
            byProvider: new Map([
              ["opencode" as const, { costUsd: index, totalTokens: index * 100 }],
            ]),
          },
        ]),
      );
      const { columns, paths } = buildChart(periods, byPeriod, metric, ["opencode"], new Set());

      expect(columns).toHaveLength(13);
      expect(columns[0]?.total).toBe(0);
      expect(columns[12]?.total).toBe(metric === "cost" ? 12 : 1200);
      expect(paths[0]?.line).toMatch(/^M0\.00,260\.00 C/);
      expect(paths[0]?.line).toMatch(/960\.00,58\.40$/);
      expect(paths[0]?.total).toBe(metric === "cost" ? 78 : 7800);
    },
  );

  it("zero-fills inactive hours and preserves hourly provider values", () => {
    const byHour = new Map([
      [
        "2026-08-11T09:37:00.000Z",
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T09:37:00.000Z",
          costUsd: 4,
          totalTokens: 40,
          byProvider: new Map([["codex" as const, { costUsd: 4, totalTokens: 40 }]]),
        },
      ],
    ]);

    expect(
      buildPeriodColumns(
        ["2026-08-11T08:37:00.000Z", "2026-08-11T09:37:00.000Z", "2026-08-11T10:37:00.000Z"],
        byHour,
        "cost",
      ).map((column) => column.total),
    ).toEqual([0, 4, 0]);
  });
});
