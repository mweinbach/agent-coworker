import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getComposerDraftAttachmentValidationMessage,
  resolveActiveComposerDraftKey,
  selectActiveComposerDraft,
} from "../../app/composerDrafts";
import { selectActiveComposerSubmission } from "../../app/composerSubmission";
import {
  getWorkspaceGoogleReasoningEffort,
  type ReasoningEffortValue,
} from "../../app/openaiCompatibleProviderOptions";
import { useAppStore } from "../../app/store";
import type { CreationOperationPhase } from "../../app/store.helpers/operationIntent";
import { isOneOffChatWorkspace } from "../../app/types";
import { Button } from "../../components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { isImeComposing, isPlainEnterWithoutIme } from "../../lib/keyboard";
import { modelDisplayNamesFromCatalog, reasoningConfigFromCatalog } from "../../lib/modelChoices";
import { resolveNewChatLandingTarget } from "../../lib/newChatLanding";
import {
  MessageComposerAttachments,
  MessageComposerBody,
  MessageComposerFooter,
  MessageComposerForm,
  MessageComposerRoot,
  MessageComposerStatus,
  MessageComposerSubmissionNotice,
  MessageComposerSubmit,
  MessageComposerTools,
} from "../composer/MessageComposer";
import { CreationReadinessNotice } from "../creation/CreationReadinessNotice";
import { useCreationReadiness } from "../creation/useCreationReadiness";
import { ComposerMentionInput } from "./ComposerMentionInput";
import { type ComposerModelSelection, ComposerModelSelector } from "./ComposerModelSelector";
import { ComposerReasoningSelector } from "./ComposerReasoningToggle";
import { buildMentionCatalog, extractReferencesFromText } from "./composerMentions";
import { resolveDefaultNewChatModel } from "./newChatLandingModel";

function creationPhaseLabel(phase: CreationOperationPhase | null): string | null {
  switch (phase) {
    case "preparing":
      return "Validating draft…";
    case "starting-server":
      return "Starting workspace runtime…";
    case "processing-attachments":
      return "Preparing attachments…";
    case "creating":
      return "Creating chat…";
    case null:
      return null;
    default: {
      const exhaustivePhase: never = phase;
      return String(exhaustivePhase);
    }
  }
}

export function NewChatLanding() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const workspaceLifecycleEnabled = useAppStore(
    (s) => s.desktopFeatureFlags.workspaceLifecycle !== false,
  );
  const composerDraft = useAppStore(selectActiveComposerDraft);
  const composerSubmission = useAppStore(selectActiveComposerSubmission);
  const composerDraftKey = useAppStore(resolveActiveComposerDraftKey);
  const attachmentIngestionPending = useAppStore(
    (state) => (state.composerAttachmentIngestionCountByKey[composerDraftKey] ?? 0) > 0,
  );
  const composerText = composerDraft.text;
  const pendingAttachments = composerDraft.attachments;
  const setComposerText = useAppStore((s) => s.setComposerText);
  const addComposerAttachments = useAppStore((s) => s.addComposerAttachments);
  const removeComposerAttachment = useAppStore((s) => s.removeComposerAttachment);
  const setComposerDraftModel = useAppStore((s) => s.setComposerDraftModel);
  const setComposerDraftReasoningEffort = useAppStore((s) => s.setComposerDraftReasoningEffort);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const submitComposerDraft = useAppStore((s) => s.submitComposerDraft);
  const retryComposerSubmission = useAppStore((s) => s.retryComposerSubmission);
  const cancelComposerSubmission = useAppStore((s) => s.cancelComposerSubmission);
  const dismissComposerSubmission = useAppStore((s) => s.dismissComposerSubmission);
  const repairCreationReadiness = useAppStore((s) => s.repairCreationReadiness);
  const releasePreparedQuickChatWorkspace = useAppStore((s) => s.releasePreparedQuickChatWorkspace);
  const newChatLandingTarget = useAppStore((s) => s.newChatLandingTarget);
  const setNewChatLandingTarget = useAppStore((s) => s.setNewChatLandingTarget);
  const target = useMemo(
    () => resolveNewChatLandingTarget(newChatLandingTarget, workspaces, selectedWorkspaceId),
    [newChatLandingTarget, selectedWorkspaceId, workspaces],
  );
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [attachmentPickerErrors, setAttachmentPickerErrors] = useState<Record<string, string>>({});
  const [creationPhase, setCreationPhase] = useState<CreationOperationPhase | null>(null);
  const [repairingReadiness, setRepairingReadiness] = useState(false);
  const [readinessRepairError, setReadinessRepairError] = useState<string | null>(null);
  const creationAbortRef = useRef<AbortController | null>(null);
  const submitting =
    composerSubmission?.phase === "preparing" || composerSubmission?.phase === "sending";
  const composerLocked = submitting || attachmentIngestionPending;
  const attachmentPickerError = attachmentPickerErrors[composerDraftKey] ?? null;
  const setAttachmentPickerError = useCallback(
    (message: string | null) => {
      setAttachmentPickerErrors((current) => {
        if (message === null) {
          if (!(composerDraftKey in current)) return current;
          const next = { ...current };
          delete next[composerDraftKey];
          return next;
        }
        return { ...current, [composerDraftKey]: message };
      });
    },
    [composerDraftKey],
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const projectWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [workspaces],
  );
  const targetWorkspace =
    target.kind === "project"
      ? (projectWorkspaces.find((workspace) => workspace.id === target.workspaceId) ?? null)
      : null;
  const selectedProjectWorkspace =
    projectWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const fallbackModelWorkspace =
    targetWorkspace ?? selectedProjectWorkspace ?? projectWorkspaces[0] ?? null;
  const targetLabel = targetWorkspace?.name ?? "Quick chat";

  // Source the @-mention catalog from the target/selected workspace; fall back to
  // any connected workspace that has skills loaded (global + built-in skills are
  // identical across workspaces, so this works in the "no project" case too).
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const mentionSourceWorkspaceId =
    targetWorkspace?.id ?? selectedWorkspaceId ?? fallbackModelWorkspace?.id ?? null;
  const mentionCatalog = useMemo(() => {
    const preferred = mentionSourceWorkspaceId
      ? workspaceRuntimeById[mentionSourceWorkspaceId]
      : undefined;
    const source =
      preferred?.skills && preferred.skills.length > 0
        ? preferred
        : (Object.values(workspaceRuntimeById).find((rt) => rt.skills && rt.skills.length > 0) ??
          preferred);
    return buildMentionCatalog(source?.skills, source?.pluginsCatalog ?? null);
  }, [workspaceRuntimeById, mentionSourceWorkspaceId]);
  const updateComposerText = useCallback(
    (text: string) => {
      setComposerText(text, extractReferencesFromText(text, mentionCatalog));
    },
    [mentionCatalog, setComposerText],
  );

  const trimmedComposerText = composerText.trim();
  const hasPendingAttachments = pendingAttachments.length > 0;
  const hasSubmittableContent =
    !attachmentIngestionPending && Boolean(trimmedComposerText || hasPendingAttachments);
  const modelDisplayNames = useMemo(
    () => modelDisplayNamesFromCatalog(providerCatalog),
    [providerCatalog],
  );
  const defaultModelSelection = useMemo(
    () => resolveDefaultNewChatModel(fallbackModelWorkspace),
    [fallbackModelWorkspace],
  );
  const modelSelection: ComposerModelSelection =
    composerDraft.provider && composerDraft.model
      ? { provider: composerDraft.provider, model: composerDraft.model }
      : defaultModelSelection;
  const readiness = useCreationReadiness({
    kind: "chat",
    workspaceId: target.kind === "project" ? targetWorkspace?.id : undefined,
    ...(targetWorkspace ? { cwd: targetWorkspace.path } : {}),
    provider: modelSelection.provider,
    model: modelSelection.model,
  });
  const readinessBlocked = Boolean(readiness.error) || readiness.result?.ready === false;
  const canSubmitNewChat =
    hasSubmittableContent && !readiness.checking && readiness.result?.ready === true;

  const reasoningConfig = useMemo(
    () =>
      reasoningConfigFromCatalog(providerCatalog, modelSelection.provider, modelSelection.model),
    [modelSelection, providerCatalog],
  );
  const workspaceReasoningEffort =
    modelSelection.provider === "openai" || modelSelection.provider === "codex-cli"
      ? fallbackModelWorkspace?.providerOptions?.[modelSelection.provider]?.reasoningEffort
      : modelSelection.provider === "google"
        ? getWorkspaceGoogleReasoningEffort(
            fallbackModelWorkspace?.providerOptions,
            modelSelection.model,
          )
        : undefined;
  const reasoningEffort: ReasoningEffortValue | null = reasoningConfig
    ? (composerDraft.reasoningEffort ?? workspaceReasoningEffort ?? reasoningConfig.defaultEffort)
    : null;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(
    () => () => {
      creationAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (submitting) return;
    creationAbortRef.current = null;
    setCreationPhase(null);
  }, [submitting]);

  const ingestAttachmentFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0 || composerLocked) return false;

      const validationMessage = getComposerDraftAttachmentValidationMessage(
        useAppStore.getState().composerDraftsByKey,
        composerDraftKey,
        selectedFiles,
      );
      if (validationMessage) {
        setAttachmentPickerError(validationMessage);
        return false;
      }

      setAttachmentPickerError(null);
      try {
        await addComposerAttachments(selectedFiles);
        return true;
      } catch (error) {
        setAttachmentPickerError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [addComposerAttachments, composerDraftKey, composerLocked, setAttachmentPickerError],
  );

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      await ingestAttachmentFiles(Array.from(files));
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [ingestAttachmentFiles],
  );

  const removeAttachment = useCallback(
    (index: number) => {
      setAttachmentPickerError(null);
      removeComposerAttachment(index);
    },
    [removeComposerAttachment, setAttachmentPickerError],
  );

  const submitNewChat = useCallback(() => {
    if (!canSubmitNewChat || submitting) return;
    setAttachmentPickerError(null);
    const controller = new AbortController();
    creationAbortRef.current = controller;
    setCreationPhase("preparing");
    const claimed = submitComposerDraft(
      {
        kind: "newChat",
        target,
        provider: modelSelection.provider,
        model: modelSelection.model,
        reasoningEffort,
      },
      {
        signal: controller.signal,
        onPhase: setCreationPhase,
      },
    );
    if (!claimed) {
      creationAbortRef.current = null;
      setCreationPhase(null);
    }
  }, [
    canSubmitNewChat,
    modelSelection,
    reasoningEffort,
    setAttachmentPickerError,
    submitComposerDraft,
    submitting,
    target,
  ]);
  const retrySubmission = useCallback(() => {
    const controller = new AbortController();
    creationAbortRef.current = controller;
    setCreationPhase("preparing");
    const claimed = retryComposerSubmission(composerDraftKey, {
      signal: controller.signal,
      onPhase: setCreationPhase,
    });
    if (!claimed) {
      creationAbortRef.current = null;
      setCreationPhase(null);
    }
  }, [composerDraftKey, retryComposerSubmission]);
  const cancelSubmission = useCallback(() => {
    creationAbortRef.current?.abort();
    creationAbortRef.current = null;
    cancelComposerSubmission(composerDraftKey);
    setCreationPhase(null);
  }, [cancelComposerSubmission, composerDraftKey]);
  const dismissSubmission = useCallback(() => {
    dismissComposerSubmission(composerDraftKey);
  }, [composerDraftKey, dismissComposerSubmission]);
  const repairReadiness = useCallback(
    async (action: Parameters<typeof repairCreationReadiness>[0]) => {
      if (repairingReadiness) return;
      setRepairingReadiness(true);
      setReadinessRepairError(null);
      try {
        await repairCreationReadiness(action, targetWorkspace?.id ?? fallbackModelWorkspace?.id);
        readiness.refresh();
      } catch (error) {
        setReadinessRepairError(error instanceof Error ? error.message : String(error));
      } finally {
        setRepairingReadiness(false);
      }
    },
    [
      fallbackModelWorkspace?.id,
      readiness,
      repairCreationReadiness,
      repairingReadiness,
      targetWorkspace?.id,
    ],
  );

  const addProjectFromSelector = useCallback(async () => {
    setSelectorOpen(false);
    await addWorkspace();
    const state = useAppStore.getState();
    const selectedProject = state.workspaces.find(
      (workspace) =>
        workspace.id === state.selectedWorkspaceId && !isOneOffChatWorkspace(workspace),
    );
    if (selectedProject) {
      await releasePreparedQuickChatWorkspace();
      setNewChatLandingTarget({ kind: "project", workspaceId: selectedProject.id });
    }
  }, [addWorkspace, releasePreparedQuickChatWorkspace, setNewChatLandingTarget]);

  const selectProjectTarget = useCallback(
    (workspaceId: string) => {
      void releasePreparedQuickChatWorkspace();
      setNewChatLandingTarget({ kind: "project", workspaceId });
      setSelectorOpen(false);
    },
    [releasePreparedQuickChatWorkspace, setNewChatLandingTarget],
  );

  const starterPrompts = useMemo(() => {
    if (targetWorkspace) {
      return [
        {
          id: "summarize-repo",
          label: "Summarize this repo",
          prompt:
            "Summarize this repository: structure, main technologies, and how to get started.",
        },
        {
          id: "explain-folder",
          label: "Explain this folder",
          prompt: "Explain the current folder: purpose, important files, and how pieces connect.",
        },
        {
          id: "find-bugs",
          label: "Find rough edges",
          prompt: "Scan the workspace for rough edges, bugs, or brittle spots worth fixing next.",
        },
        {
          id: "write-tests",
          label: "Suggest tests",
          prompt: "Suggest high-value tests for the most important behavior in this workspace.",
        },
      ] as const;
    }
    return [
      {
        id: "draft-plan",
        label: "Draft a plan",
        prompt: "Help me turn an idea into a clear, actionable plan.",
      },
      {
        id: "brainstorm",
        label: "Brainstorm options",
        prompt: "Help me brainstorm several approaches and compare their trade-offs.",
      },
      {
        id: "polish-writing",
        label: "Polish writing",
        prompt: "Help me make this writing clearer, tighter, and more persuasive.",
      },
    ] as const;
  }, [targetWorkspace]);

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden bg-panel px-5 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[42%] size-[min(44rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[image:var(--surface-landing-accent-glow)]"
      />
      <div className="relative flex w-full max-w-[52rem] flex-col items-center gap-9">
        <header className="flex max-w-[34rem] flex-col items-center gap-3 text-center">
          <h1 className="text-balance text-[2.125rem] font-medium leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[2.75rem]">
            What should we work on?
          </h1>
          <p className="text-balance text-[15px] leading-relaxed text-muted-foreground/88">
            Describe a task, idea, or question — Cowork will take it from here.
          </p>
        </header>
        <div className="flex w-full max-w-[42rem] flex-wrap items-center justify-center gap-2">
          {starterPrompts.map((starter) => (
            <Button
              key={starter.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={composerLocked}
              className="h-8 rounded-full border-border/60 bg-background/70 px-3 text-xs font-medium text-muted-foreground transition-[transform,background-color,color,border-color] duration-150 hover:-translate-y-px hover:border-border hover:bg-background hover:text-foreground"
              onClick={() => {
                updateComposerText(starter.prompt);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            >
              {starter.label}
            </Button>
          ))}
        </div>
        <div className="w-full max-w-[42rem]">
          <CreationReadinessNotice
            checking={readiness.checking}
            error={readinessRepairError ?? readiness.error}
            result={readiness.result}
            repairing={repairingReadiness}
            onRepair={(action) => void repairReadiness(action)}
            onRetry={readiness.refresh}
          />
        </div>
        <MessageComposerRoot
          className="w-full max-w-[42rem] rounded-[28px] border-border/45 bg-background/94 app-shadow-overlay backdrop-blur-md transition-shadow focus-within:shadow-[var(--shadow-popover)]"
          fileDrop={submitting ? undefined : { onFiles: ingestAttachmentFiles }}
        >
          <MessageComposerAttachments
            attachments={pendingAttachments}
            onRemove={removeAttachment}
          />
          <MessageComposerSubmissionNotice
            submission={composerSubmission}
            onRetry={retrySubmission}
            onDismiss={dismissSubmission}
          />
          <MessageComposerForm
            onSubmit={(event) => {
              event.preventDefault();
              submitNewChat();
            }}
          >
            <MessageComposerStatus role="status" aria-live="polite" aria-atomic="true">
              {submitting
                ? (creationPhaseLabel(creationPhase) ?? "Starting chat…")
                : readiness.checking
                  ? "Validating readiness…"
                  : readinessBlocked
                    ? "Setup required"
                    : null}
            </MessageComposerStatus>
            <MessageComposerBody>
              {attachmentPickerError ? (
                <div
                  role="alert"
                  className="flex min-w-0 items-start gap-1.5 px-1 pb-1 text-xs text-destructive"
                >
                  <AlertTriangleIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {attachmentPickerError}
                  </span>
                </div>
              ) : null}
              <ComposerMentionInput
                textareaRef={textareaRef}
                value={composerText}
                setValue={updateComposerText}
                disabled={composerLocked}
                placeholder="Message Cowork..."
                catalog={mentionCatalog}
                ariaLabel="New chat message"
                textareaClassName="min-h-[5.5rem] text-[16px] leading-relaxed placeholder:text-muted-foreground/75"
                onPasteFiles={(files) => void ingestAttachmentFiles(files)}
                onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                  const isComposing = isImeComposing(event.nativeEvent);
                  if (isPlainEnterWithoutIme(event)) {
                    event.preventDefault();
                    if (!canSubmitNewChat || submitting) return;
                    submitNewChat();
                  } else if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !isComposing
                  ) {
                    event.preventDefault();
                    const textarea = event.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const value = textarea.value;
                    const newValue = `${value.substring(0, start)}\n${value.substring(end)}`;
                    updateComposerText(newValue);
                    requestAnimationFrame(() => {
                      textarea.selectionStart = textarea.selectionEnd = start + 1;
                    });
                  }
                }}
              />
            </MessageComposerBody>
            <MessageComposerFooter className="gap-3 pt-1">
              <MessageComposerTools className="gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={composerLocked}
                  className="rounded-full text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                  aria-label="Attach files"
                  title="Attach files"
                >
                  <PaperclipIcon />
                </Button>
                <Popover open={selectorOpen} onOpenChange={setSelectorOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 min-w-0 max-w-full gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground/90 hover:bg-muted/35 hover:text-foreground"
                      aria-label="Select chat target"
                      disabled={composerLocked}
                    >
                      {target.kind === "project" ? (
                        <FolderIcon className="size-4 shrink-0" />
                      ) : (
                        <MessageSquareIcon className="size-4 shrink-0" />
                      )}
                      <span className="truncate">{targetLabel}</span>
                      <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-70" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    sideOffset={8}
                    className="w-[min(23rem,calc(100vw-3rem))] overflow-hidden rounded-xl border-border/70 bg-popover p-1 shadow-xl shadow-foreground/10"
                  >
                    <Command className="rounded-lg bg-transparent text-[15px] [&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:rounded-t-lg [&_[data-slot=command-input-wrapper]]:border-b-border/60 [&_[data-slot=command-input-wrapper]]:bg-background/70 [&_[data-slot=command-input-wrapper]]:px-3.5 [&_[data-slot=command-input-wrapper]_svg]:opacity-60">
                      <CommandInput placeholder="Search projects" className="h-11 text-[15px]" />
                      <CommandList className="max-h-[20rem] py-1">
                        <CommandEmpty className="py-8 text-sm text-muted-foreground">
                          No projects found.
                        </CommandEmpty>
                        <CommandGroup
                          heading="Projects"
                          className="p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[0.72rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em]"
                        >
                          {projectWorkspaces.map((workspace) => (
                            <CommandItem
                              key={workspace.id}
                              value={workspace.name}
                              className="h-10 rounded-lg px-2.5 text-[15px] data-[selected=true]:bg-muted/70"
                              onSelect={() => selectProjectTarget(workspace.id)}
                            >
                              <FolderIcon className="size-4" />
                              <span className="truncate">{workspace.name}</span>
                              {target.kind === "project" && target.workspaceId === workspace.id ? (
                                <CheckIcon className="ml-auto size-4 text-primary" />
                              ) : null}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                        <CommandSeparator className="-mx-1 my-1 bg-border/60" />
                        <CommandGroup className="p-1.5">
                          {workspaceLifecycleEnabled ? (
                            <CommandItem
                              value="Add new project"
                              className="h-10 rounded-lg px-2.5 text-[15px] data-[selected=true]:bg-muted/70"
                              onSelect={addProjectFromSelector}
                            >
                              <FolderPlusIcon className="size-4" />
                              <span>Add new project</span>
                            </CommandItem>
                          ) : null}
                          <CommandItem
                            value="Quick chat"
                            className="h-10 rounded-lg px-2.5 text-[15px] data-[selected=true]:bg-muted/70"
                            onSelect={() => {
                              setNewChatLandingTarget({ kind: "oneOff" });
                              setSelectorOpen(false);
                            }}
                          >
                            <MessageSquareIcon className="size-4" />
                            <span>Quick chat</span>
                            {target.kind === "oneOff" ? (
                              <CheckIcon className="ml-auto size-4 text-primary" />
                            ) : null}
                          </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {modelSelection.model ? (
                  <>
                    <ComposerModelSelector
                      provider={modelSelection.provider}
                      model={modelSelection.model}
                      modelDisplayNames={modelDisplayNames}
                      disabled={composerLocked}
                      onChange={(selection) => {
                        setComposerDraftModel(selection.provider, selection.model);
                      }}
                    />
                    {reasoningConfig && reasoningEffort ? (
                      <ComposerReasoningSelector
                        value={reasoningEffort}
                        options={reasoningConfig.availableEfforts}
                        disabled={composerLocked}
                        onChange={setComposerDraftReasoningEffort}
                      />
                    ) : null}
                  </>
                ) : null}
              </MessageComposerTools>
              {submitting ? (
                <Button type="button" variant="ghost" size="sm" onClick={cancelSubmission}>
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
              ) : null}
              <MessageComposerSubmit
                status={composerLocked ? "pending" : "ready"}
                disabled={!canSubmitNewChat || composerLocked}
              />
            </MessageComposerFooter>
          </MessageComposerForm>
        </MessageComposerRoot>
      </div>
    </div>
  );
}
