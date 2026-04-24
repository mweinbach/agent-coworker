import { PaperclipIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { useResearchAttachments } from "./useResearchAttachments";

export function ResearchFollowUpComposer({
  parentResearchId,
  disabled,
  onSubmitted,
  autoFocus,
  placeholder,
  className,
}: {
  parentResearchId: string;
  disabled?: boolean;
  onSubmitted?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const sendResearchFollowUp = useAppStore((s) => s.sendResearchFollowUp);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { attachments, attachmentPreviews, addFiles, removeAttachment, clearAttachments } =
    useResearchAttachments();

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
        setInput("");
        clearAttachments();
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
    <>
      <PromptInputRoot
        className={cn("max-w-none", className)}
        fileDrop={{
          disabled: disabled || submitting,
          onFiles: async (files) => {
            addFiles(files);
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
            onRemove={removeAttachment}
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
          addFiles(files);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}
