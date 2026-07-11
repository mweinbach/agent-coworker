import { AlertTriangleIcon, PaperclipIcon, Settings2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import {
  beginCreationOperationIntent,
  type CreationOperationPhase,
  isCreationNavigationIntentCurrent,
} from "../../app/store.helpers/operationIntent";
import { Button } from "../../components/ui/button";
import {
  MessageComposerAttachments,
  MessageComposerBody,
  MessageComposerFooter,
  MessageComposerForm,
  MessageComposerRoot,
  MessageComposerStatus,
  MessageComposerSubmit,
  MessageComposerTextarea,
  MessageComposerTools,
} from "../composer/MessageComposer";
import { ResearchSettingsDialog } from "./ResearchSettingsPopover";
import { useResearchAttachments } from "./useResearchAttachments";

function researchPhaseLabel(phase: CreationOperationPhase | null): string | null {
  switch (phase) {
    case "preparing":
      return "Preparing research...";
    case "starting-server":
      return "Starting the research service...";
    case "processing-attachments":
      return "Uploading research files...";
    case "creating":
      return "Starting research...";
    case null:
      return null;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

export function NewResearchComposer({ onSubmitted }: { onSubmitted?: () => void }) {
  const startResearch = useAppStore((s) => s.startResearch);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [creationPhase, setCreationPhase] = useState<CreationOperationPhase | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const { attachments, attachmentPreviews, addFiles, removeAttachment, clearAttachments } =
    useResearchAttachments();

  const submit = async () => {
    const trimmed = input.trim();
    if (!trimmed || submitting) {
      return;
    }
    const operationIntent = beginCreationOperationIntent();
    const controller = new AbortController();
    submissionControllerRef.current = controller;
    setCreationError(null);
    setCreationPhase("preparing");
    setSubmitting(true);
    try {
      const created = await startResearch({
        input: trimmed,
        files: attachments.map((attachment) => attachment.file),
        intent: operationIntent,
        signal: controller.signal,
        onPhase: setCreationPhase,
      });
      if (
        created &&
        !controller.signal.aborted &&
        isCreationNavigationIntentCurrent(operationIntent)
      ) {
        setInput("");
        clearAttachments();
        setSettingsOpen(false);
        onSubmitted?.();
      } else if (!created || controller.signal.aborted) {
        setCreationError(
          controller.signal.aborted
            ? created
              ? "Research started in the background before cancellation completed. Your draft was preserved."
              : "Research creation cancelled. Your draft was preserved."
            : "Unable to start research. Your draft was preserved.",
        );
      }
    } finally {
      if (submissionControllerRef.current === controller) {
        submissionControllerRef.current = null;
      }
      setCreationPhase(null);
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-3xl px-4 py-4">
      <div className="mb-4 space-y-1">
        <h2 className="text-base font-semibold tracking-tight text-foreground">New research</h2>
        <p className="text-sm text-muted-foreground">
          Describe what you want investigated. Cowork will plan sources, gather evidence, and draft
          a cited report you can export.
        </p>
      </div>
      <MessageComposerRoot
        fileDrop={{
          disabled: submitting,
          onFiles: async (files) => {
            addFiles(files);
          },
        }}
      >
        <MessageComposerForm
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <MessageComposerAttachments
            attachments={attachmentPreviews}
            onRemove={submitting ? () => {} : removeAttachment}
          />

          <MessageComposerStatus>
            {submitting ? researchPhaseLabel(creationPhase) : null}
          </MessageComposerStatus>
          <MessageComposerBody>
            {creationError ? (
              <div className="flex min-w-0 items-start gap-1.5 px-1 pb-1 text-xs text-destructive">
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {creationError}
                </span>
              </div>
            ) : null}
            <MessageComposerTextarea
              value={input}
              onChange={(event) => {
                setCreationError(null);
                setInput(event.target.value);
              }}
              placeholder="Investigate a market, compare vendors, summarize a benchmark run, or draft a cited brief."
              rows={4}
              disabled={submitting}
            />
          </MessageComposerBody>

          <MessageComposerFooter>
            <MessageComposerTools>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full"
                onClick={() => setSettingsOpen(true)}
                aria-label="Research settings"
                disabled={submitting}
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
                disabled={submitting}
              >
                <PaperclipIcon className="h-4 w-4" />
              </Button>
            </MessageComposerTools>
            {submitting ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => submissionControllerRef.current?.abort()}
              >
                Cancel
              </Button>
            ) : null}
            <MessageComposerSubmit
              status={submitting ? "pending" : "ready"}
              disabled={!input.trim()}
            />
          </MessageComposerFooter>
        </MessageComposerForm>
      </MessageComposerRoot>

      <ResearchSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        disabled={submitting}
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          addFiles(files);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
