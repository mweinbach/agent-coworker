import { useEffect, useMemo, useRef, useState } from "react";
import { PaperclipIcon, Settings2Icon } from "lucide-react";

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
import { ResearchMcpPickerDialog } from "./ResearchMcpPickerDialog";
import { ResearchSettingsDialog } from "./ResearchSettingsPopover";

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

export function NewResearchComposer({
  onSubmitted,
}: {
  onSubmitted?: () => void;
}) {
  const startResearch = useAppStore((s) => s.startResearch);
  const researchDraftSettings = useAppStore((s) => s.researchDraftSettings);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
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
        for (const attachment of attachments) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
        setInput("");
        setAttachments([]);
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
              <div className="text-xs text-muted-foreground">
                {researchDraftSettings.mcpServersEnabled && researchDraftSettings.mcpServerNames.length > 0
                  ? `${researchDraftSettings.mcpServerNames.length} MCP server${researchDraftSettings.mcpServerNames.length === 1 ? "" : "s"} saved for later`
                  : "Google Search and URL Context stay on by default"}
              </div>
            </PromptInputTools>
            <PromptInputSubmit
              status={submitting ? "pending" : "ready"}
              disabled={!input.trim()}
            />
          </PromptInputFooter>
        </PromptInputForm>
      </PromptInputRoot>

      <ResearchSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onOpenMcpPicker={() => setMcpDialogOpen(true)}
      />

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

      <ResearchMcpPickerDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
    </div>
  );
}
