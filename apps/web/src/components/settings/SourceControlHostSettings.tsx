import { secretSettingsFields, type EnvironmentId } from "@t3tools/contracts";
import type { SourceControlDefinition } from "@t3tools/client-runtime/source-control-clients";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

export function SourceControlHostSettings({
  environmentId,
  definition,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition & {
    readonly settings: NonNullable<SourceControlDefinition["settings"]>;
  };
  readonly onSaved: () => void;
}) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sourceControlHosts[definition.kind],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} settings`,
  });
  const [saving, setSaving] = useState(false);
  const [overlay, setOverlay] = useState<{
    before: Record<string, unknown>;
    fields: Record<string, unknown>;
  } | null>(null);
  // A stream update wins per field; unrelated settings pushes must not erase an unacknowledged edit.
  const pendingFields = Object.fromEntries(
    Object.entries(overlay?.fields ?? {}).filter(([key]) => saved?.[key] === overlay?.before[key]),
  );
  if (
    overlay !== null &&
    Object.keys(pendingFields).length !== Object.keys(overlay.fields).length
  ) {
    setOverlay(
      Object.keys(pendingFields).length > 0 ? { ...overlay, fields: pendingFields } : null,
    );
  }
  const displayed = { ...saved, ...pendingFields };
  const secretKeys = new Set(secretSettingsFields(definition.settings));
  const mask = (fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        secretKeys.has(key) ? (value ? "configured" : "") : value,
      ]),
    );
  const formDefinition = { settingsSchema: definition.settings };
  const hasSaved = Object.values(displayed).some((value) => value !== "" && value !== undefined);

  const save = async (fields: Record<string, unknown>) => {
    const previous = overlay;
    const keys = [...new Set([...Object.keys(pendingFields), ...Object.keys(fields)])];
    const before = Object.fromEntries(
      keys.map((key) => [key, key in pendingFields ? overlay?.before[key] : saved?.[key]]),
    );
    // Keep only secret presence in UI state, never a replacement token.
    setOverlay({ before, fields: mask({ ...pendingFields, ...fields }) });
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sourceControlHosts: { [definition.kind]: fields } } },
    });
    setSaving(false);
    if (result._tag === "Success") {
      const acknowledged = result.value.sourceControlHosts[definition.kind] ?? {};
      setOverlay({
        before,
        fields: mask(Object.fromEntries(keys.map((key) => [key, acknowledged[key]]))),
      });
      onSaved();
    } else {
      setOverlay(previous);
    }
  };

  return (
    // Locked while saving, so an edit made mid-request is not overwritten by the saved value.
    <fieldset disabled={saving} className="contents">
      <ProviderSettingsForm
        definition={formDefinition}
        value={displayed}
        idPrefix={`source-control-${definition.kind}-${environmentId}`}
        variant="settings"
        onChange={(next) => {
          const fields = next ?? {};
          const changed = Object.fromEntries(
            Object.entries(fields).filter(([key, value]) => displayed[key] !== value),
          );
          const cleared = Object.keys(displayed).filter((key) => !(key in fields));
          void save({ ...changed, ...Object.fromEntries(cleared.map((key) => [key, ""])) });
        }}
      />
      {hasSaved ? (
        <div className="flex justify-end pt-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void save(Object.fromEntries(Object.keys(displayed).map((key) => [key, ""])))
            }
          >
            Remove
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
