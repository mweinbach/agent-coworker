import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PaperclipIcon,
} from "lucide-react";
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAttachmentCountValidationMessage } from "../../../../../src/shared/attachments";
import { buildAttachmentDisplayText } from "../../app/attachmentInputs";
import {
  getWorkspaceGoogleReasoningEffort,
  type ReasoningEffortValue,
} from "../../app/openaiCompatibleProviderOptions";
import { useAppStore } from "../../app/store";
import { ensureServerRunning } from "../../app/store.helpers";
import type { FileAttachmentInput } from "../../app/store.helpers/jsonRpcSocket";
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
import {
  appendAttachmentSkippedNotes,
  type ComposerAttachmentFile,
  createComposerAttachmentFile,
  resolveComposerAttachmentsForWorkspace,
  revokeComposerAttachmentPreview,
} from "../../lib/composerAttachments";
import { modelDisplayNamesFromCatalog, reasoningConfigFromCatalog } from "../../lib/modelChoices";
import { resolveNewChatLandingTarget } from "../../lib/newChatLanding";
import {
  MessageComposerAttachments,
  MessageComposerBody,
  MessageComposerFooter,
  MessageComposerForm,
  MessageComposerRoot,
  MessageComposerStatus,
  MessageComposerSubmit,
  MessageComposerTools,
} from "../composer/MessageComposer";
import { ComposerMentionInput } from "./ComposerMentionInput";
import { type ComposerModelSelection, ComposerModelSelector } from "./ComposerModelSelector";
import { ComposerReasoningSelector } from "./ComposerReasoningToggle";
import { buildMentionCatalog, extractReferencesFromText } from "./composerMentions";
import { resolveDefaultNewChatModel } from "./newChatLandingModel";

export function NewChatLanding() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const workspaceLifecycleEnabled = useAppStore(
    (s) => s.desktopFeatureFlags.workspaceLifecycle !== false,
  );
  const composerText = useAppStore((s) => s.composerText);
  const setComposerText = useAppStore((s) => s.setComposerText);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const newChatLandingTarget = useAppStore((s) => s.newChatLandingTarget);
  const setNewChatLandingTarget = useAppStore((s) => s.setNewChatLandingTarget);
  const target = useMemo(
    () => resolveNewChatLandingTarget(newChatLandingTarget, workspaces, selectedWorkspaceId),
    [newChatLandingTarget, selectedWorkspaceId, workspaces],
  );
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modelTouched, setModelTouched] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachmentFile[]>([]);
  const [attachmentPickerError, setAttachmentPickerError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<ComposerAttachmentFile[]>([]);

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
  const targetLabel = targetWorkspace?.name ?? "Don't work in a project";

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

  const trimmedComposerText = composerText.trim();
  const hasPendingAttachments = pendingAttachments.length > 0;
  const canSubmitNewChat = Boolean(trimmedComposerText || hasPendingAttachments);
  const modelDisplayNames = useMemo(
    () => modelDisplayNamesFromCatalog(providerCatalog),
    [providerCatalog],
  );
  const defaultModelSelection = useMemo(
    () => resolveDefaultNewChatModel(fallbackModelWorkspace),
    [fallbackModelWorkspace],
  );
  const [modelSelection, setModelSelection] =
    useState<ComposerModelSelection>(defaultModelSelection);
  const [reasoningOverride, setReasoningOverride] = useState<{
    provider: ComposerModelSelection["provider"];
    model: string;
    effort: ReasoningEffortValue;
  } | null>(null);

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
    ? reasoningOverride?.provider === modelSelection.provider &&
      reasoningOverride.model === modelSelection.model
      ? reasoningOverride.effort
      : (workspaceReasoningEffort ?? reasoningConfig.defaultEffort)
    : null;
  useEffect(() => {
    if (!modelTouched) {
      setModelSelection(defaultModelSelection);
    }
  }, [defaultModelSelection, modelTouched]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach(revokeComposerAttachmentPreview);
    };
  }, []);

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((current) => {
      current.forEach(revokeComposerAttachmentPreview);
      return [];
    });
  }, []);

  const ingestAttachmentFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0 || submitting) return;

      const validationMessage = getAttachmentCountValidationMessage(
        pendingAttachments.length + selectedFiles.length,
      );
      if (validationMessage) {
        setAttachmentPickerError(validationMessage);
        return;
      }

      setAttachmentPickerError(null);
      setPendingAttachments((prev) => [
        ...prev,
        ...selectedFiles.map(createComposerAttachmentFile),
      ]);
    },
    [pendingAttachments.length, submitting],
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

  const removeAttachment = useCallback((index: number) => {
    setAttachmentPickerError(null);
    setPendingAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) {
        revokeComposerAttachmentPreview(removed);
      }
      return next;
    });
  }, []);

  const submitNewChat = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (!canSubmitNewChat || submitting) {
        return;
      }

      setSubmitting(true);
      setAttachmentPickerError(null);

      const attachmentTitleHint = buildAttachmentDisplayText(
        pendingAttachments.map((attachment) => ({ filename: attachment.filename })),
      );
      const titleHint = trimmedComposerText || attachmentTitleHint || "New chat";
      const references = extractReferencesFromText(composerText, mentionCatalog);
      const referencesArg = references.length > 0 ? references : undefined;

      try {
        let firstMessage = trimmedComposerText;
        let attachments: FileAttachmentInput[] | undefined;
        let attachmentFiles: File[] | undefined;

        if (hasPendingAttachments) {
          if (target.kind === "project") {
            await ensureServerRunning(
              useAppStore.getState,
              useAppStore.setState,
              target.workspaceId,
            );
            const resolved = await resolveComposerAttachmentsForWorkspace(
              useAppStore.getState,
              useAppStore.setState,
              target.workspaceId,
              pendingAttachments,
            );
            attachments = resolved.attachments.length > 0 ? resolved.attachments : undefined;
            firstMessage = appendAttachmentSkippedNotes(firstMessage, resolved.skippedNotes);
          } else {
            attachmentFiles = pendingAttachments.map((attachment) => attachment.file);
          }
        }

        const ok =
          target.kind === "project"
            ? await newThread({
                scope: "project",
                workspaceId: target.workspaceId,
                firstMessage,
                titleHint,
                mode: "session",
                attachments,
                references: referencesArg,
                provider: modelSelection.provider,
                model: modelSelection.model,
                reasoningEffort: reasoningEffort ?? undefined,
              })
            : await newThread({
                scope: "oneOff",
                firstMessage,
                titleHint,
                mode: "session",
                attachmentFiles,
                references: referencesArg,
                provider: modelSelection.provider,
                model: modelSelection.model,
                reasoningEffort: reasoningEffort ?? undefined,
              });

        if (ok) {
          clearPendingAttachments();
          setComposerText("");
        } else {
          setSubmitting(false);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAttachmentPickerError(message);
        setSubmitting(false);
      }
    },
    [
      canSubmitNewChat,
      clearPendingAttachments,
      composerText,
      hasPendingAttachments,
      mentionCatalog,
      modelSelection,
      newThread,
      pendingAttachments,
      reasoningEffort,
      setComposerText,
      submitting,
      target,
      trimmedComposerText,
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
      setNewChatLandingTarget({ kind: "project", workspaceId: selectedProject.id });
    }
  }, [addWorkspace, setNewChatLandingTarget]);

  const starterPrompts = useMemo(
    () =>
      [
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
      ] as const,
    [],
  );

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
              disabled={submitting}
              className="h-8 rounded-full border-border/60 bg-background/70 px-3 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={() => {
                setComposerText(starter.prompt);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            >
              {starter.label}
            </Button>
          ))}
        </div>
        <MessageComposerRoot
          className="w-full max-w-[42rem] rounded-[28px] border-border/55 bg-background/94 app-shadow-overlay backdrop-blur-md transition-shadow focus-within:shadow-[var(--shadow-popover)]"
          fileDrop={
            submitting ? undefined : { onFiles: (files) => void ingestAttachmentFiles(files) }
          }
        >
          <MessageComposerAttachments
            attachments={pendingAttachments}
            onRemove={removeAttachment}
          />
          <MessageComposerForm onSubmit={submitNewChat}>
            <MessageComposerStatus>
              {submitting ? "Starting a new chat..." : null}
            </MessageComposerStatus>
            <MessageComposerBody>
              {attachmentPickerError ? (
                <div className="flex min-w-0 items-start gap-1.5 px-1 pb-1 text-xs text-destructive">
                  <AlertTriangleIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {attachmentPickerError}
                  </span>
                </div>
              ) : null}
              <ComposerMentionInput
                textareaRef={textareaRef}
                value={composerText}
                setValue={setComposerText}
                disabled={submitting}
                placeholder="Message Cowork..."
                catalog={mentionCatalog}
                ariaLabel="New chat message"
                textareaClassName="min-h-[5.5rem] text-[16px] leading-relaxed placeholder:text-muted-foreground/75"
                onPasteFiles={(files) => void ingestAttachmentFiles(files)}
                onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                  const isComposing =
                    event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.altKey
                  ) {
                    if (isComposing) return;
                    event.preventDefault();
                    if (!canSubmitNewChat || submitting) return;
                    void submitNewChat();
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
                    setComposerText(newValue);
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
                  disabled={submitting}
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
                      disabled={submitting}
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
                              onSelect={() => {
                                setNewChatLandingTarget({
                                  kind: "project",
                                  workspaceId: workspace.id,
                                });
                                setSelectorOpen(false);
                              }}
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
                            value="Don't work in a project"
                            className="h-10 rounded-lg px-2.5 text-[15px] data-[selected=true]:bg-muted/70"
                            onSelect={() => {
                              setNewChatLandingTarget({ kind: "oneOff" });
                              setSelectorOpen(false);
                            }}
                          >
                            <MessageSquareIcon className="size-4" />
                            <span>Don't work in a project</span>
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
                      disabled={submitting}
                      onChange={(selection) => {
                        setModelTouched(true);
                        setModelSelection(selection);
                      }}
                    />
                    {reasoningConfig && reasoningEffort ? (
                      <ComposerReasoningSelector
                        value={reasoningEffort}
                        options={reasoningConfig.availableEfforts}
                        disabled={submitting}
                        onChange={(effort) => {
                          setReasoningOverride({
                            provider: modelSelection.provider,
                            model: modelSelection.model,
                            effort,
                          });
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
              </MessageComposerTools>
              <MessageComposerSubmit
                status={submitting ? "pending" : "ready"}
                disabled={!canSubmitNewChat || submitting}
              />
            </MessageComposerFooter>
          </MessageComposerForm>
        </MessageComposerRoot>
      </div>
    </div>
  );
}
