import { AlertTriangleIcon, PaperclipIcon, RotateCcwIcon, Settings2Icon } from "lucide-react";
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
import { CreationReadinessNotice } from "../creation/CreationReadinessNotice";
import { useCreationReadiness } from "../creation/useCreationReadiness";
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
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const researchTransportWorkspaceId = useAppStore((s) => s.researchTransportWorkspaceId);
  const repairCreationReadiness = useAppStore((s) => s.repairCreationReadiness);
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
  const [cancelling, setCancelling] = useState(false);
  const [creationPhase, setCreationPhase] = useState<CreationOperationPhase | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repairingReadiness, setRepairingReadiness] = useState(false);
  const [readinessRepairError, setReadinessRepairError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const researchRequestIdentityRef = useRef<{ revision: number; id: string } | null>(null);
  const readinessWorkspaceId = researchTransportWorkspaceId ?? selectedWorkspaceId ?? undefined;
  const readinessWorkspace =
    workspaces.find((workspace) => workspace.id === readinessWorkspaceId) ?? null;
  const readiness = useCreationReadiness({
    kind: "research",
    workspaceId: readinessWorkspaceId,
    ...(readinessWorkspace ? { cwd: readinessWorkspace.path } : {}),
  });
  const attachmentPreviews = draft.attachments.map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    previewUrl: attachment.previewUrl,
  }));

  const repairReadiness = async (
    action: Parameters<typeof repairCreationReadiness>[0],
  ): Promise<void> => {
    if (repairingReadiness) return;
    setRepairingReadiness(true);
    setReadinessRepairError(null);
    try {
      await repairCreationReadiness(action, readinessWorkspaceId);
      readiness.refresh();
    } catch (error) {
      setReadinessRepairError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairingReadiness(false);
    }
  };

  const submit = async () => {
    const trimmed = draft.text.trim();
    if (!trimmed || submitting || readiness.checking || readiness.result?.ready !== true) {
      return;
    }
    const draftRevision = draft.revision;
    const requestIdentity =
      researchRequestIdentityRef.current?.revision === draftRevision
        ? researchRequestIdentityRef.current
        : { revision: draftRevision, id: crypto.randomUUID() };
    researchRequestIdentityRef.current = requestIdentity;
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
        clientResearchId: requestIdentity.id,
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
      if (
        controller.signal.aborted &&
        researchRequestIdentityRef.current?.id === requestIdentity.id
      ) {
        researchRequestIdentityRef.current = null;
      }
      setCreationPhase(null);
      setCancelling(false);
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
      <CreationReadinessNotice
        checking={readiness.checking}
        error={readinessRepairError ?? readiness.error}
        result={readiness.result}
        repairing={repairingReadiness}
        onRepair={(action) => void repairReadiness(action)}
        onRetry={readiness.refresh}
      />
      <MessageComposerRoot
        className="mt-3"
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

          <MessageComposerStatus aria-live="polite">
            {submitting
              ? cancelling
                ? "Cancelling research…"
                : researchPhaseLabel(creationPhase)
              : readiness.result?.ready
                ? "Ready"
                : readiness.checking
                  ? "Validating readiness…"
                  : "Setup required"}
          </MessageComposerStatus>
          <MessageComposerBody>
            {creationError ? (
              <div
                className="flex min-w-0 items-start gap-1.5 px-1 pb-1 text-xs text-destructive"
                role="alert"
                aria-live="assertive"
              >
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {creationError}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={submitting || readiness.result?.ready !== true}
                  onClick={() => void submit()}
                >
                  <RotateCcwIcon data-icon="inline-start" />
                  Retry
                </Button>
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
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  submissionControllerRef.current?.abort();
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            ) : null}
            <MessageComposerSubmit
              status={submitting ? "pending" : "ready"}
              disabled={
                !draft.text.trim() ||
                submitting ||
                readiness.checking ||
                readiness.result?.ready !== true
              }
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
