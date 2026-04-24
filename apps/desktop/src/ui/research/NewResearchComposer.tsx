import { PaperclipIcon, Settings2Icon } from "lucide-react";
import { useRef, useState } from "react";

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
import { ResearchSettingsDialog } from "./ResearchSettingsPopover";
import { useResearchAttachments } from "./useResearchAttachments";

export function NewResearchComposer({ onSubmitted }: { onSubmitted?: () => void }) {
  const startResearch = useAppStore((s) => s.startResearch);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { attachments, attachmentPreviews, addFiles, removeAttachment, clearAttachments } =
    useResearchAttachments();

  const submit = async () => {
    const trimmed = input.trim();
    if (!trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await startResearch({
        input: trimmed,
        files: attachments.map((attachment) => attachment.file),
      });
      if (created) {
        setInput("");
        clearAttachments();
        setSettingsOpen(false);
        onSubmitted?.();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-3xl px-4 py-4">
      <PromptInputRoot
        fileDrop={{
          disabled: submitting,
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
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Investigate a market, compare vendors, summarize a benchmark run, or draft a cited brief."
              rows={4}
              disabled={submitting}
            />
          </PromptInputBody>

          <PromptInputFooter>
            <PromptInputTools>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full"
                onClick={() => setSettingsOpen(true)}
                aria-label="Research settings"
              >
                <Settings2Icon className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
              >
                <PaperclipIcon className="h-4 w-4" />
              </Button>
            </PromptInputTools>
            <PromptInputSubmit status={submitting ? "pending" : "ready"} disabled={!input.trim()} />
          </PromptInputFooter>
        </PromptInputForm>
      </PromptInputRoot>

      <ResearchSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

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
    </div>
  );
}
