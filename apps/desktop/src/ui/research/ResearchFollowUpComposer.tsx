import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaperclipIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import {
  PromptInputAttachmentPreviews,
  PromptInputBody,
  PromptInputFooter,
  PromptInputForm,
  PromptInputRoot,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../../components/ai-elements/prompt-input";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

type AttachmentDraft = {
  file: File;
  filename: string;
  mimeType: string;
  previewUrl?: string;
};

function toAttachmentDraft(file: File): AttachmentDraft {
  return {
    file,
    filename: file.name || "upload.bin",
    mimeType: file.type || "application/octet-stream",
    ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
  };
}

export function ResearchFollowUpComposer({
  parentResearchId,
  disabled,
  onSubmitted,
  autoFocus,
  placeholder,
  className,
  toolbarExtra,
}: {
  parentResearchId: string;
  disabled?: boolean;
  onSubmitted?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  toolbarExtra?: ReactNode;
}) {
  const sendResearchFollowUp = useAppStore((s) => s.sendResearchFollowUp);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      for (const attachment of attachments) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    };
  }, [attachments]);

  const attachmentPreviews = useMemo(
    () => attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      previewUrl: attachment.previewUrl,
    })),
    [attachments],
  );

  const submit = async () => {
    const trimmed = input.trim();
    if (!trimmed || submitting || disabled) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await sendResearchFollowUp({
        parentResearchId,
        input: trimmed,
        files: attachments.map((attachment) => attachment.file),
      });
      if (created) {
        for (const attachment of attachments) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
        setInput("");
        setAttachments([]);
        onSubmitted?.();
      }
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  return (
    <div className={cn("rounded-2xl border border-border/65 bg-card/80 px-3 py-3", className)}>
      <PromptInputRoot
        className="max-w-none"
        fileDrop={{
          disabled: disabled || submitting,
          onFiles: async (files) => {
            setAttachments((current) => [...current, ...files.map((file) => toAttachmentDraft(file))]);
          },
        }}
      >
        <PromptInputForm
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <PromptInputAttachmentPreviews
            attachments={attachmentPreviews}
            onRemove={(index) => {
              setAttachments((current) => {
                const next = [...current];
                const [removed] = next.splice(index, 1);
                if (removed?.previewUrl) {
                  URL.revokeObjectURL(removed.previewUrl);
                }
                return next;
              });
            }}
          />
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={placeholder ?? "Ask a follow-up that continues from this report…"}
              rows={2}
              disabled={disabled || submitting}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
                disabled={disabled || submitting}
              >
                <PaperclipIcon className="h-4 w-4" />
              </Button>
              {toolbarExtra}
            </PromptInputTools>
            <PromptInputSubmit
              status={submitting ? "pending" : "ready"}
              disabled={disabled || !input.trim()}
            />
          </PromptInputFooter>
        </PromptInputForm>
      </PromptInputRoot>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          if (files.length > 0) {
            setAttachments((current) => [...current, ...files.map((file) => toAttachmentDraft(file))]);
          }
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
