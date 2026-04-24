import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ResearchAttachmentDraft = {
  file: File;
  filename: string;
  mimeType: string;
  previewUrl?: string;
};

function toAttachmentDraft(file: File): ResearchAttachmentDraft {
  return {
    file,
    filename: file.name || "upload.bin",
    mimeType: file.type || "application/octet-stream",
    ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
  };
}

function revokePreviews(attachments: ResearchAttachmentDraft[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

export function useResearchAttachments() {
  const [attachments, setAttachments] = useState<ResearchAttachmentDraft[]>([]);
  const attachmentsRef = useRef<ResearchAttachmentDraft[]>(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => revokePreviews(attachmentsRef.current), []);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setAttachments((current) => {
      const next = [...current, ...files.map((file) => toAttachmentDraft(file))];
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((current) => {
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((current) => {
      revokePreviews(current);
      attachmentsRef.current = [];
      return [];
    });
  }, []);

  const attachmentPreviews = useMemo(
    () =>
      attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        previewUrl: attachment.previewUrl,
      })),
    [attachments],
  );

  return {
    attachments,
    attachmentPreviews,
    addFiles,
    removeAttachment,
    clearAttachments,
  };
}
