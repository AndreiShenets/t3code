import { describe, expect, it } from "vite-plus/test";
import {
  usageSeriesColor,
  usageSeriesKey,
  usageSeriesLabel,
  usageSeriesValue,
} from "./usageSeries.ts";

describe("usage series", () => {
  it("labels known providers and preserves custom IDs", () => {
    expect(
      usageSeriesLabel({ provider: "opencode", upstreamProvider: "github-copilot" }, "OpenCode"),
    ).toBe("OpenCode · GitHub Copilot");
    expect(
      usageSeriesLabel({ provider: "opencode", upstreamProvider: "my-provider" }, "OpenCode"),
    ).toBe("OpenCode · my-provider");
    expect(usageSeriesLabel({ provider: "opencode", upstreamProvider: "openai" }, "OpenCode")).toBe(
      "OpenCode · OpenAI",
    );
    expect(usageSeriesLabel({ provider: "opencode" }, "OpenCode")).toBe("OpenCode");
  });

  it("keeps identities and colors stable across surfaces and independent of order", () => {
    const openai = { provider: "opencode" as const, upstreamProvider: "openai" };
    const copilot = { ...openai, upstreamProvider: "github-copilot" };
    expect(usageSeriesKey(openai)).not.toBe(usageSeriesKey(copilot));
    expect(usageSeriesColor(openai, "blue")).not.toBe(usageSeriesColor(copilot, "blue"));
    expect(usageSeriesColor(openai, "blue")).toBe(usageSeriesColor(openai, "red"));
    expect(usageSeriesColor({ provider: "opencode" }, "blue")).toBe("blue");
  });

  it("falls back to unsplit totals only for unsplit history", () => {
    const period = {
      day: "2026-10-20",
      costUsd: 10,
      totalTokens: 100,
      byProvider: new Map([["opencode" as const, { costUsd: 10, totalTokens: 100 }]]),
    };
    expect(usageSeriesValue(period, { provider: "opencode" })?.costUsd).toBe(10);
    expect(
      usageSeriesValue(period, { provider: "opencode", upstreamProvider: "openai" }),
    ).toBeUndefined();
    expect(
      usageSeriesValue({ ...period, bySeries: new Map() }, { provider: "opencode" }),
    ).toBeUndefined();
  });
});
