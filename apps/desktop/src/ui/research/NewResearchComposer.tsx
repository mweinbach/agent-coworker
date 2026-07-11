import { AlertTriangleIcon, PaperclipIcon, Settings2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { operationKey } from "../../app/store.helpers";
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
import { OperationFeedback } from "../OperationFeedback";
import { ResearchSettingsDialog } from "./ResearchSettingsPopover";

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
  const draft = useAppStore((s) => s.researchCreationDraft);
  const creationError = useAppStore((s) =>
    s.researchCreationError?.revision === s.researchCreationDraft.revision
      ? s.researchCreationError.message
      : null,
  );
  const setResearchCreationInput = useAppStore((s) => s.setResearchCreationInput);
  const addResearchCreationAttachments = useAppStore((s) => s.addResearchCreationAttachments);
  const removeResearchCreationAttachment = useAppStore((s) => s.removeResearchCreationAttachment);
  const setResearchCreationError = useAppStore((s) => s.setResearchCreationError);
  const [creationOperationKey, setCreationOperationKey] = useState<string | null>(null);
  const operation = useAppStore((state) =>
    creationOperationKey ? state.operationsByKey[creationOperationKey] : undefined,
  );
  const [submitting, setSubmitting] = useState(false);
  const [creationPhase, setCreationPhase] = useState<CreationOperationPhase | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const attachmentPreviews = draft.attachments.map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    previewUrl: attachment.previewUrl,
  }));

  const submit = async () => {
    const trimmed = draft.text.trim();
    if (!trimmed || submitting) {
      return;
    }
    const draftRevision = draft.revision;
    const operationIntent = beginCreationOperationIntent();
    setCreationOperationKey(operationKey("research", "start", operationIntent.operationId));
    const controller = new AbortController();
    submissionControllerRef.current = controller;
    setResearchCreationError(draftRevision, null);
    setCreationPhase("preparing");
    setSubmitting(true);
    try {
      const created = await startResearch({
        input: trimmed,
        files: draft.attachments.map((attachment) => attachment.file),
        draftRevision,
        intent: operationIntent,
        signal: controller.signal,
        onPhase: setCreationPhase,
      });
      if (
        created.ok &&
        !controller.signal.aborted &&
        isCreationNavigationIntentCurrent(operationIntent)
      ) {
        setSettingsOpen(false);
        onSubmitted?.();
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
            try {
              await addResearchCreationAttachments(files);
            } catch (error) {
              setResearchCreationError(
                draft.revision,
                error instanceof Error ? error.message : String(error),
              );
            }
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
            onRemove={submitting ? () => {} : removeResearchCreationAttachment}
            disabled={submitting}
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
              value={draft.text}
              onChange={(event) => {
                setResearchCreationInput(event.target.value);
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
              disabled={!draft.text.trim()}
            />
          </MessageComposerFooter>
        </MessageComposerForm>
      </MessageComposerRoot>
      <OperationFeedback operation={operation} className="mt-3" />

      <ResearchSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        disabled={submitting}
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          void addResearchCreationAttachments(files).catch((error: unknown) => {
            setResearchCreationError(
              draft.revision,
              error instanceof Error ? error.message : String(error),
            );
          });
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
