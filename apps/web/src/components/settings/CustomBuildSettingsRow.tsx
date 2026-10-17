import { useCustomBuildUpdate } from "../../hooks/useCustomBuildUpdate";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CustomBuildSettingsRow() {
  const { state, visible, disabled, label, description, change } = useCustomBuildUpdate();
  if (!visible) return null;

  return (
    <SettingsRow
      {...searchableSetting("custom-build")}
      description={description}
      control={
        <div className="flex gap-2">
          {state?.status === "available" || state?.status === "downloaded" ? (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => change(true)}>
              Check Again
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => change()}>
            {label}
          </Button>
        </div>
      }
    />
  );
}
