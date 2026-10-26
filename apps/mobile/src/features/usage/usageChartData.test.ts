import { describe, expect, it, vi } from "vite-plus/test";
import { usageSeriesKey } from "@t3tools/shared/usageSeries";
import { buildChartDays } from "./usageChartData";

vi.mock("./usageProviders", () => ({ PROVIDER_ORDER: ["opencode"] }));

describe("buildChartDays", () => {
  it.each(["cost", "tokens"] as const)(
    "stacks each upstream %s once, including unattributed history",
    (metric) => {
      const series = [
        { provider: "opencode" as const },
        { provider: "opencode" as const, upstreamProvider: "openai" },
        { provider: "opencode" as const, upstreamProvider: "github-copilot" },
      ];
      const daily = [
        {
          day: "2026-10-20",
          costUsd: 12,
          totalTokens: 120,
          byProvider: new Map([["opencode" as const, { costUsd: 12, totalTokens: 120 }]]),
          bySeries: new Map([
            [usageSeriesKey(series[1]!), { costUsd: 10, totalTokens: 100 }],
            [usageSeriesKey(series[2]!), { costUsd: 2, totalTokens: 20 }],
          ]),
        },
      ];
      const days = buildChartDays(["2026-10-20", "2026-10-21"], daily, metric, series);
      expect(days[0]?.values.map((entry) => entry.value)).toEqual(
        metric === "cost" ? [0, 10, 2] : [0, 100, 20],
      );
      expect(days[0]?.total).toBe(metric === "cost" ? 12 : 120);
      expect(days[1]?.total).toBe(0);
    },
  );
});
