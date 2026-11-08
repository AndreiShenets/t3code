import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";

import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironmentScope } from "~/state/session";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { EditableFileSurface } from "../files/FilePreviewPanel";
import SourceFilePreview from "../files/ReadOnlySourcePreview";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { filePreviewReadErrorMessage } from "../files/filePreviewMode";
import {
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "../files/fileSurfaceChrome";
import { projectFileCacheKey } from "../files/fileContentRevision";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

const ignorePendingChange = () => {};
const ignorePostRender = () => {};

export default function PullRequestFileEditor({
  environmentId,
  workspaceRoot,
  relativePath,
  onClose,
}: {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  relativePath: string;
  onClose: () => void;
}) {
  const file = useProjectFileQuery(environmentId, workspaceRoot, relativePath, true);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{relativePath}</DialogTitle>
          <DialogDescription>
            Current checkout.{" "}
            {canWrite ? "Changes are saved automatically." : "Read-only connection."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-[70dvh] min-h-0 flex-col overflow-hidden">
          {file.error && file.data === null ? (
            <FileSurfaceFailure
              message={file.readError ? filePreviewReadErrorMessage(file.readError) : file.error}
              onRetry={file.refresh}
            />
          ) : file.data === null ? (
            <FileSurfaceLoading />
          ) : !canWrite || file.data.truncated ? (
            <>
              {file.data.truncated ? (
                <FileSurfaceNotice>
                  This file is too large to edit. Showing a partial preview.
                </FileSurfaceNotice>
              ) : null}
              <SourceFilePreview
                workspace={{ environmentId, cwd: workspaceRoot }}
                name={relativePath}
                text={file.data.contents}
                cacheKey={projectFileCacheKey(workspaceRoot, relativePath, file.data.contents)}
              />
            </>
          ) : (
            <DiffWorkerPoolProvider>
              <EditableFileSurface
                key={`${environmentId}:${workspaceRoot}:${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={workspaceRoot}
                relativePath={relativePath}
                composerDraftTarget={null}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                revealRequestId={0}
                wordWrap={wordWrap}
                onPostRender={ignorePostRender}
                onPendingChange={ignorePendingChange}
              />
            </DiffWorkerPoolProvider>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
