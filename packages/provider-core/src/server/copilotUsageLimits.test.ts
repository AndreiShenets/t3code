import { describe, expect, it } from "vite-plus/test";
import { copilotMonthlyWindow } from "./copilotUsageLimits.ts";

const reset = "2026-12-01T00:00:00.000Z";
const budget = {
  quotaId: "premium_interactions",
  unit: "ai_credits",
  observationKind: "account_snapshot",
  quantityKind: "authoritative_budget",
  acquisitionStatus: "succeeded",
  entitledQuantity: 110_000,
  availableQuantity: 55_770,
  budgetMetadata: {
    resetAtEpochMs: Date.parse(reset),
    overageAllowedWhenExhausted: true,
  },
};

describe("Copilot SDK quota", () => {
  it("shows the account credit balance, reset, and whether usage can continue", () => {
    expect(copilotMonthlyWindow({ providerQuotas: [budget] })).toMatchObject({
      kind: "monthly",
      label: "Copilot: 54,230 / 110,000 AI credits",
      resetsAt: reset,
      canContinueAfterExhaustion: true,
    });
    expect(copilotMonthlyWindow({ providerQuotas: [budget] })?.usedPercent).toBeCloseTo(49.3);
  });

  it("does not treat request quotas, failed acquisitions, or ambiguous budgets as credits", () => {
    expect(
      copilotMonthlyWindow({ providerQuotas: [{ ...budget, unit: "requests" }] }),
    ).toBeUndefined();
    expect(
      copilotMonthlyWindow({
        providerQuotas: [{ ...budget, acquisitionStatus: "failed" }],
      }),
    ).toBeUndefined();
    expect(copilotMonthlyWindow({ providerQuotas: [budget, budget] })).toBeUndefined();
  });
});
