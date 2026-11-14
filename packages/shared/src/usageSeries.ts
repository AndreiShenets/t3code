import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals, HourlyTotals, MergedUsage } from "./usageMerge.ts";

export interface UsageSeries {
  readonly provider: UsageProviderKind;
  readonly upstreamProvider?: string | undefined;
}

export function usageSeriesKey(series: UsageSeries): string {
  return series.upstreamProvider === undefined
    ? series.provider
    : JSON.stringify([series.provider, series.upstreamProvider]);
}

export function usageModelKey(model: UsageSeries & { readonly model: string }): string {
  return JSON.stringify([model.provider, model.upstreamProvider ?? null, model.model]);
}

function upstreamProviderLabel(provider: string): string {
  if (provider === "github-copilot") return "GitHub Copilot";
  if (provider === "openai") return "OpenAI";
  return provider;
}

export function usageSeriesLabel(series: UsageSeries, providerLabel: string): string {
  return series.upstreamProvider === undefined
    ? providerLabel
    : `${providerLabel} · ${upstreamProviderLabel(series.upstreamProvider)}`;
}

export function usageSeriesColor(series: UsageSeries, providerColor: string): string {
  if (series.upstreamProvider === undefined) return providerColor;
  if (series.upstreamProvider === "github-copilot") return "#b884d6";
  if (series.upstreamProvider === "openai") return "#4d9f8a";
  let hash = 0;
  for (const char of series.upstreamProvider) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `hsl(${((hash % 360) + 360) % 360}, 50%, 55%)`;
}

export function usageSeriesValue(
  period: DailyTotals | HourlyTotals | undefined,
  series: UsageSeries,
) {
  return period?.bySeries === undefined
    ? series.upstreamProvider === undefined
      ? period?.byProvider.get(series.provider)
      : undefined
    : period.bySeries.get(usageSeriesKey(series));
}

export function usageSeriesTotals(usage: MergedUsage) {
  const totals = new Map<string, UsageSeries & { costUsd: number; totalTokens: number }>();
  for (const model of usage.models) {
    const key = usageSeriesKey(model);
    const entry = totals.get(key) ?? {
      provider: model.provider,
      ...(model.upstreamProvider === undefined ? {} : { upstreamProvider: model.upstreamProvider }),
      costUsd: 0,
      totalTokens: 0,
    };
    entry.costUsd += model.costUsd;
    entry.totalTokens += model.totalTokens;
    totals.set(key, entry);
  }
  return [...totals.values()];
}
