import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { usageSeriesValue, type UsageSeries } from "@t3tools/shared/usageSeries";

import { PROVIDER_ORDER } from "./usageProviders";

export type UsageChartMetric = "cost" | "tokens";

export interface UsageChartDay {
  readonly day: string;
  readonly values: readonly (UsageSeries & { readonly value: number })[];
  readonly total: number;
}

export function buildChartDays(
  days: readonly string[],
  daily: readonly DailyTotals[],
  metric: UsageChartMetric,
  series: readonly UsageSeries[] = PROVIDER_ORDER.map((provider) => ({ provider })),
): readonly UsageChartDay[] {
  const byDay = new Map(daily.map((totals) => [totals.day, totals]));
  return days.map((day) => {
    const totals = byDay.get(day);
    const values = series.map((series) => {
      const entry = usageSeriesValue(totals, series);
      const value = entry === undefined ? 0 : metric === "cost" ? entry.costUsd : entry.totalTokens;
      return { ...series, value };
    });
    return {
      day,
      values,
      total: values.reduce((sum, entry) => sum + entry.value, 0),
    };
  });
}
