import type { EnvironmentId, ThreadId, UsageProviderKind } from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDateTimeShort,
  formatDayShort,
  makeSpanWindow,
} from "@t3tools/shared/usageFormat";
import { useGT, useLocale } from "gt-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { mergeAnsweredUsage, refreshThreadUsage, useThreadUsage } from "../../state/usage";
import { resolveHour12 } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Dialog, DialogPanel, DialogPopup } from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { AppRouteModalClose } from "../AppRouteModal";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import {
  UsageModelDialogHost,
  UsageOverview,
  UsageProviderFilter,
  UsageSkeleton,
  selectUsageModel,
} from "./UsagePage";

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

export default function ThreadUsageDialog({
  environmentId,
  threadId,
  sinceMs,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** When the thread started; the window runs from then to now. */
  readonly sinceMs: number;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const [window, setWindow] = useState(() => ({ ...makeSpanWindow(sinceMs), threadId }));
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [hiddenProviders, setHiddenProviders] = useState(NO_HIDDEN_PROVIDERS);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [priceModel, setPriceModel] = useState<string | null>(null);
  const status = useThreadUsage(environmentId, window);
  // A server that predates thread filters answers for every thread; never show that as this one's.
  const unsupported =
    status?.summary != null && status.summary.threadId !== threadId
      ? gt("This environment's server can't report usage for a single thread.")
      : null;
  const environment =
    status === null || unsupported === null ? status : { ...status, summary: null };
  const environments = environment === null ? [] : [environment];
  const merged = mergeAnsweredUsage(
    environments,
    hiddenProviders.size === 0 ? undefined : (bucket) => !hiddenProviders.has(bucket.provider),
  );
  const hourly = window.resolution === "hour";
  const days = enumerateDays(window.sinceDay, window.untilDay);
  const hours =
    window.sinceTime === undefined || window.untilTime === undefined
      ? []
      : enumerateHourStarts(window.sinceTime, window.untilTime);
  const since =
    hourly && window.sinceTime !== undefined
      ? formatDateTimeShort(window.sinceTime, window.timeZone, hour12, locale)
      : formatDayShort(window.sinceDay, locale);
  const message = unsupported ?? environment?.error ?? null;

  const refresh = () => {
    if (isRefreshing) return;
    const next = { ...makeSpanWindow(sinceMs), threadId };
    setWindow(next);
    setIsRefreshing(true);
    void refreshThreadUsage(environmentId, next).finally(() => setIsRefreshing(false));
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogPopup className="max-w-5xl" showCloseButton={false} aria-label={gt("Thread usage")}>
          <header className="flex min-h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
            <WorkspaceBreadcrumb ariaLabel={gt("Thread usage")} className="shrink-0">
              <WorkspaceBreadcrumbItem>
                <h2>{gt("Thread usage")}</h2>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <UsageProviderFilter
                  hiddenProviders={hiddenProviders}
                  onChange={(next) => setHiddenProviders(new Set(next))}
                />
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {gt("Since {start} · Includes subagents", { start: since })}
            </span>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <ToggleGroup
                aria-label={gt("Usage metric")}
                variant="segmented"
                value={[metric]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "cost" || value === "tokens") setMetric(value);
                }}
              >
                <Toggle value="cost">{gt("Cost")}</Toggle>
                <Toggle value="tokens">{gt("Tokens")}</Toggle>
              </ToggleGroup>
              <Button
                onClick={refresh}
                aria-label={gt("Refresh usage")}
                aria-busy={isRefreshing}
                disabled={isRefreshing || environment?.canReadDiagnostics !== true}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshIcon size="sm" refreshing={isRefreshing} />
              </Button>
              <AppRouteModalClose />
            </div>
          </header>
          <DialogPanel>
            {environment === null ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {gt("Connect an environment to see usage.")}
              </p>
            ) : message !== null ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{message}</p>
            ) : environment.summary === null ? (
              <UsageSkeleton />
            ) : (
              <UsageOverview
                merged={merged}
                shownWindow={window}
                hour12={hour12}
                days={days}
                hours={hours}
                showingKept={false}
                metric={metric}
                selectedEnvironments={environments}
                hiddenProviders={hiddenProviders}
                refreshingUsage={isRefreshing}
                showChatGptSharing={false}
                onSelectModel={selectUsageModel}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <UsageModelDialogHost
        models={merged.models}
        environments={environments}
        metric={metric}
        chartWindow={{
          days,
          hours,
          resolution: hourly ? "hour" : "day",
          timeZone: window.timeZone,
          referenceTime: window.untilTime,
          hour12,
        }}
        onSetPrice={(model) => setPriceModel(model)}
      />
      {priceModel !== null ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={new Set([environmentId])}
          initialModel={priceModel}
          onOpenChange={(open) => {
            if (!open) setPriceModel(null);
          }}
        />
      ) : null}
    </>
  );
}
