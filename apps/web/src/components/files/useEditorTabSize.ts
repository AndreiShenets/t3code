import { useState } from "react";

/** Keep the composing editor mounted until its native compositionend handler commits. */
export function useEditorTabSize(resolvedTabSize: number, sourceVersion: number) {
  const [composition, setComposition] = useState<{ tabSize: number; sourceVersion: number } | null>(
    null,
  );
  const tabSize =
    composition?.sourceVersion === sourceVersion ? composition.tabSize : resolvedTabSize;
  const onCompositionStartCapture = () => setComposition({ tabSize, sourceVersion });
  const onCompositionEnd = () => setComposition(null);
  return { tabSize, onCompositionStartCapture, onCompositionEnd };
}
