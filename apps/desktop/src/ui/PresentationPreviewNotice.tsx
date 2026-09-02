import { AlertTriangleIcon } from "lucide-react";

import type { PresentationPreviewResult } from "../../../../src/server/presentationPreview";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";

export type PresentationPreviewNoticeProps = Pick<
  Extract<PresentationPreviewResult, { ok: true }>,
  "renderingMode" | "warnings"
>;

export function PresentationPreviewNotice({
  renderingMode,
  warnings = [],
}: PresentationPreviewNoticeProps) {
  const textOnly = renderingMode === "text";
  const details = warnings.filter(
    (warning) => warning.trim() && !(textOnly && warning.startsWith("Text-only preview:")),
  );
  if (!textOnly && details.length === 0) return null;

  return (
    <Alert
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-presentation-notice={textOnly ? "text" : "warning"}
      className="mt-2 shrink-0 py-2"
    >
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle className="text-xs">
        {textOnly ? "Text-only preview" : "Preview warning"}
      </AlertTitle>
      <AlertDescription className="max-h-24 overflow-y-auto break-words text-xs leading-relaxed [&_p:not(:last-child)]:mb-1">
        {textOnly ? (
          <p>
            Images, charts, layout, and original styling are not shown. Long slide text may be
            shortened.
          </p>
        ) : null}
        {details.length > 0 ? <p>{details.join(" ")}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
