import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { EditorId, type EnvironmentId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { memo, use, useRef } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { shortcutLabelForCommand } from "../../keybindings";
import type { FileManagerAction } from "./OpenInPicker.logic";
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
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { cn } from "~/lib/utils";
import { announce } from "~/lib/announce";
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
  fileManagerAction = "open",
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
  fileManagerAction?: FileManagerAction;
}) {
  const gt = useGT();

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
  } = useEditorLauncher(environmentId, availableEditors, fileManagerAction === "reveal");
  const [menuOpen, setMenuOpen] = useComposerMenuState(isHostEditorDenied);
  const environmentLabel = useEnvironment(environmentId)?.label ?? null;
  const isEditorUnavailable = (editor: EditorId | null) =>
    editor === "file-manager" && fileManagerAction === "unavailable";
  const openInEditor = async (editorId: EditorId | null): Promise<boolean> => {
    const editor = editorId ?? preferredEditor;
    return !isEditorUnavailable(editor) && open(editor, openInCwd, openInCwdIsFile);
  };

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  const backgroundThread = use(BackgroundThreadContext);
  const primaryLabel = isPanel
    ? primaryOption
      ? gt("Open in {editor}", { editor: primaryOption.label })
      : gt("Open in editor")
    : gt("Open", { $context: "verb, opens the project in the preferred editor" });

  const unavailableReason =
    remote.mode === "remote-unavailable"
      ? environmentLabel !== null
        ? gt("No SSH route to {environment}", { environment: environmentLabel })
        : gt("No SSH route to this machine")
      : remote.mode === "remote-links" && options.length === 0
        ? environmentLabel !== null
          ? gt("Open from a computer to edit on {environment}", { environment: environmentLabel })
          : gt("Open from a computer to edit on this machine")
        : null;

  const editorItems = (
    <>
      {unavailableReason !== null ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          {unavailableReason}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              <T>No installed editors found</T>
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={
                !openInCwd ||
                !canOpenEditor ||
                (presentation === "menu" && isEditorUnavailable(value))
              }
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
              {environmentLabel !== null
                ? gt("Opens over SSH. Needs your key on {environment}", {
                    environment: environmentLabel,
                  })
                : gt("Opens over SSH. Needs your key on this machine")}
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
            disabled={!openInCwd || !canOpenEditor || isEditorUnavailable(preferredEditor)}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>
              <T>
                Open in <Var>{primaryOption.label}</Var>
              </T>
            </MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>
              <T>Open in…</T>
            </MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  const primaryControlLabel = compact ? gt("Open file in preferred editor") : primaryLabel;
  const primaryControl = (
    <ThreadDetailsControl
      aria-label={primaryControlLabel}
      // Tooltip replaces the button data-slot, so toolbar theming needs a separate hook.
      data-toolbar-control=""
      size={isPanel ? "sm" : "xs"}
      variant={isPanel ? "ghost" : "outline"}
      part="primary"
      panel={isPanel}
      disabled={
        !preferredEditor || !openInCwd || !canOpenEditor || isEditorUnavailable(preferredEditor)
      }
      {...(enableShortcut && !backgroundThread ? { [OPEN_FAVORITE_EDITOR_ATTRIBUTE]: "" } : {})}
      onClick={() => {
        if (!preferredEditor) return;
        const label = primaryOption?.label ?? preferredEditor;
        void openInEditor(preferredEditor).then((opened) => {
          if (opened) announce(gt("Opened in {editor}", { editor: label }));
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
        <SquareArrowOutUpRightIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
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
  );

  return (
    <ActionGroup
      aria-label={gt("Open in editor")}
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <SharedTooltipTrigger render={primaryControl} label={primaryControlLabel} />
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <SharedTooltipTrigger
          render={
            <MenuTrigger
              disabled={isHostEditorDenied}
              render={
                <ThreadDetailsControl
                  aria-label={gt("Choose editor")}
                  data-toolbar-control=""
                  size={isPanel ? "sm" : "icon-xs"}
                  variant={isPanel ? "ghost" : "outline"}
                  part="secondary"
                  panel={isPanel}
                />
              }
            />
          }
          label={
            <>
              <T>Choose editor</T>
            </>
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </SharedTooltipTrigger>
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
