import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { FolderClosedIcon } from "lucide-react";

import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  type Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VisualStudioIcon,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

const resolveOpenInOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    { Icon: CursorIcon, value: "cursor", kind: "brand" },
    { Icon: TraeIcon, value: "trae", kind: "brand" },
    { Icon: KiroIcon, value: "kiro", kind: "brand" },
    { Icon: VisualStudioCode, value: "vscode", kind: "brand" },
    { Icon: VisualStudioCodeInsiders, value: "vscode-insiders", kind: "brand" },
    { Icon: VSCodium, value: "vscodium", kind: "brand" },
    { Icon: Zed, value: "zed", kind: "brand" },
    { Icon: AntigravityIcon, value: "antigravity", kind: "brand" },
    { Icon: IntelliJIdeaIcon, value: "idea", kind: "brand" },
    { Icon: AquaIcon, value: "aqua", kind: "brand" },
    { Icon: CLionIcon, value: "clion", kind: "brand" },
    { Icon: DataGripIcon, value: "datagrip", kind: "brand" },
    { Icon: DataSpellIcon, value: "dataspell", kind: "brand" },
    { Icon: GoLandIcon, value: "goland", kind: "brand" },
    { Icon: PhpStormIcon, value: "phpstorm", kind: "brand" },
    { Icon: PyCharmIcon, value: "pycharm", kind: "brand" },
    { Icon: RiderIcon, value: "rider", kind: "brand" },
    { Icon: RubyMineIcon, value: "rubymine", kind: "brand" },
    { Icon: RustRoverIcon, value: "rustrover", kind: "brand" },
    { Icon: WebStormIcon, value: "webstorm", kind: "brand" },
    { Icon: VisualStudioIcon, value: "visual-studio", kind: "brand" },
    {
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({ ...option, label: editorLabelForPlatform(option.value, platform) }));
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

  const options = resolveOpenInOptions(navigator.platform, effectiveEditors);
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
