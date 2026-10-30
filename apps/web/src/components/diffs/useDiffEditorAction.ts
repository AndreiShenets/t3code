import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { resolveFileContextMenuAbsolutePath } from "~/fileContextMenu";
import { serverEnvironment } from "~/state/server";
import { getOpenInIconClass, useEditorLauncher } from "../chat/useEditorLauncher";

export function useDiffEditorAction(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const { primaryOption, canOpenEditor, open } = useEditorLauncher(
    environmentId,
    serverConfig?.availableEditors ?? [],
    true,
  );

  return (filePath: string) => {
    if (environmentId === null || workspaceRoot === undefined || primaryOption === null)
      return null;
    const absolutePath = resolveFileContextMenuAbsolutePath({
      environmentId,
      filePath,
      workspaceRoot,
      repositoryRoot,
    });
    if (absolutePath === null) return null;
    return {
      Icon: primaryOption.Icon,
      label: `Open in ${primaryOption.label}`,
      iconClassName: getOpenInIconClass(primaryOption.kind),
      disabled: !canOpenEditor,
      onOpen: () => {
        void open(null, absolutePath, true);
      },
    };
  };
}
