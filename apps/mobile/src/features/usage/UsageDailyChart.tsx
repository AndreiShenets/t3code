import { View } from "react-native";

import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { usageSeriesKey, usageSeriesColor, type UsageSeries } from "@t3tools/shared/usageSeries";

import { buildChartDays, type UsageChartMetric } from "./usageChartData";
import { useProviderColors } from "./usageProviders";

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly height: number;
  readonly series?: readonly UsageSeries[];
}

export function UsageDailyChart({ days, daily, metric, height, series }: UsageDailyChartProps) {
  const colors = useProviderColors();
  const chartDays = buildChartDays(days, daily, metric, series);
  const max = chartDays.reduce((peak, day) => Math.max(peak, day.total), 0);

  return (
    <View style={{ height }} className="flex-row items-end gap-px">
      {/* Use column-reverse: provider values are bottom-first and Hermes lacks toReversed. */}
      {chartDays.map((day) => (
        <View
          key={day.day}
          style={{ height: max === 0 ? 0 : (day.total / max) * height }}
          className="flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
        >
          {day.values.map((entry) => (
            <View
              key={usageSeriesKey(entry)}
              style={{
                height: max === 0 ? 0 : (entry.value / max) * height,
                backgroundColor: usageSeriesColor(entry, colors[entry.provider]),
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
