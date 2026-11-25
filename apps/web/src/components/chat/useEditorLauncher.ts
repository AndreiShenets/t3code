import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";

import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { type EditorIconOption, editorIconOptions } from "../editorIcons";
import { cn } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

type OpenInOption = EditorIconOption & { label: string };

const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
  resolve: MessageResolver,
): ReadonlyArray<OpenInOption> => {
  const availableEditorSet = new Set(availableEditors);
  return editorIconOptions(platform)
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({
      ...option,
      label: editorLabelForPlatform(option.value, platform, resolve),
    }));
};

export function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export function useEditorLauncher(
  environmentId: EnvironmentId | null,
  availableEditors: ReadonlyArray<EditorId>,
  revealFileManager = false,
) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isHostEditorDenied = remote.mode === "local-exec" && !canOperateHost;
  const canOpenEditor =
    environmentId !== null && remote.mode !== "remote-unavailable" && !isHostEditorDenied;
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  // Remote mode ignores the server's PATH probe: what matters is what runs on
  // the viewing machine, which only the desktop app can probe.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);

  const open = async (editorId: EditorId | null, path: string | null, isFile = false) => {
    if (!path || environmentId === null) return false;
    const editor = editorId ?? preferredEditor;
    if (!editor || remote.mode === "remote-unavailable") return false;
    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({ editor, ...remote.host, absolutePath: path, isFile });
      if (url === undefined) return false;
      // Only record hint-seen/preferred when the shell actually accepted
      // the URL (an older desktop build can refuse the editor scheme).
      const opened = await openRemoteEditorUrl(url);
      if (!opened) return false;
      markRemoteHintSeen();
      setPreferredEditor(editor);
      return true;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    const result = openInEditorMutation({
      environmentId,
      input: {
        cwd: path,
        editor,
        ...(revealFileManager && editor === "file-manager" ? { reveal: true } : {}),
      },
    });
    setPreferredEditor(editor);
    return (await result)._tag === "Success";
  };

  const messages = useMessages();
  const options = resolveOpenInOptions(navigator.platform, effectiveEditors, messages);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  return {
    remote,
    remoteHintSeen,
    isHostEditorDenied,
    canOpenEditor,
    preferredEditor,
    setPreferredEditor,
    options,
    primaryOption,
    open,
  };
}
