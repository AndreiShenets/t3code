import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { EditorId, type EnvironmentId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo, use, useRef } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { OPEN_FAVORITE_EDITOR_ATTRIBUTE } from "./OpenInPickerShortcut";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, SquareArrowOutUpRightIcon } from "lucide-react";

import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import { cn } from "~/lib/utils";
import { announce } from "~/lib/announce";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { useComposerMenuState } from "./useComposerMenuState";
import { getOpenInIconClass, useEditorLauncher } from "./useEditorLauncher";

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  openInCwdIsFile = false,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
  revealFileManager = false,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  openInCwdIsFile?: boolean;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
  revealFileManager?: boolean;
}) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const {
    remote,
    remoteHintSeen,
    isHostEditorDenied,
    canOpenEditor,
    preferredEditor,
    setPreferredEditor,
    options,
    primaryOption,
    open,
  } = useEditorLauncher(environmentId, availableEditors, revealFileManager);
  const [menuOpen, setMenuOpen] = useComposerMenuState(isHostEditorDenied);
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  const openInEditor = (editorId: EditorId | null) => open(editorId, openInCwd, openInCwdIsFile);

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  const backgroundThread = use(BackgroundThreadContext);
  const primaryLabel = isPanel ? `Open in ${primaryOption?.label ?? "editor"}` : "Open";

  const editorItems = (
    <>
      {remote.mode === "remote-unavailable" ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          No SSH route to {environmentLabel}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              No installed editors found
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={!openInCwd || !canOpenEditor}
              key={value}
              onClick={() => {
                if (presentation === "menu") {
                  void openInEditor(value);
                } else {
                  setPreferredEditor(value);
                }
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              Opens over SSH. Needs your key on {environmentLabel}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}

            disabled={!openInCwd || !canOpenEditor}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>Open in {primaryOption.label}</MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>Open in…</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <ThreadDetailsControl
        aria-label={compact ? "Open file in preferred editor" : primaryLabel}
        size={isPanel ? "sm" : "xs"}
        variant={isPanel ? "ghost" : "outline"}
        part="primary"
        panel={isPanel}
        disabled={!preferredEditor || !openInCwd || !canOpenEditor}
        {...(enableShortcut && !backgroundThread ? { [OPEN_FAVORITE_EDITOR_ATTRIBUTE]: "" } : {})}
        onClick={() => {
          if (!preferredEditor) return;
          const label = editorLabelForPlatform(preferredEditor, navigator.platform);
          void openInEditor(preferredEditor).then((opened) => {
            if (opened) announce(`Opened in ${label}`);
          });
        }}
      >
        {primaryOption?.Icon ? (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn(
              isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
              getOpenInIconClass(primaryOption.kind),
            )}
          />
        ) : isPanel ? (
          <SquareArrowOutUpRightIcon
            aria-hidden="true"
            className={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
        ) : null}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
          )}
        >
          {primaryLabel}
        </span>
      </ThreadDetailsControl>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          disabled={isHostEditorDenied}
          render={
            <ThreadDetailsControl
              aria-label="Choose editor"
              size={isPanel ? "sm" : "icon-xs"}
              variant={isPanel ? "ghost" : "outline"}
              part="secondary"
              panel={isPanel}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </MenuTrigger>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {editorItems}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
