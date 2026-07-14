import { AlertTriangleIcon, PaperclipIcon } from "lucide-react";
import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
  RefObject,
} from "react";
import type { ComposerSubmission } from "../../app/composerSubmission";
import type { ReasoningEffortValue } from "../../app/openaiCompatibleProviderOptions";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import type { ComposerAttachmentFile } from "../../lib/composerAttachments";
import type { ProviderName } from "../../lib/wsProtocol";
import {
  MessageComposerAttachments,
  MessageComposerBody,
  MessageComposerFooter,
  MessageComposerForm,
  MessageComposerRoot,
  MessageComposerStatus,
  MessageComposerStop,
  MessageComposerSubmissionNotice,
  MessageComposerSubmit,
  MessageComposerTools,
} from "../composer/MessageComposer";
import { MessageBarResizer } from "../layout/MessageBarResizer";
import { ComposerMentionInput } from "./ComposerMentionInput";
import { ComposerReasoningSelector } from "./ComposerReasoningToggle";
import type { getComposerSubmitState } from "./chatLogic";
import type { MentionCatalog } from "./composerMentions";
import { ThreadModelSelector } from "./ThreadModelSelector";

type ComposerSubmitState = ReturnType<typeof getComposerSubmitState>;

export function ChatComposer(props: {
  messageBarOverlayRef: Ref<HTMLDivElement>;
  composerOverlayMinHeight: number;
  messageBarHeight: number;
  inputDisabled: boolean;
  transcriptOnly: boolean;
  ingestAttachmentFiles: (files: File[]) => Promise<boolean>;
  pendingAttachments: ComposerAttachmentFile[];
  removeAttachment: (index: number) => void;
  submitComposer: () => void;
  busy: boolean;
  composerHint: string | null;
  composerSubmitState: ComposerSubmitState;
  attachmentPickerError: string | null;
  composerText: string;
  setComposerText: (text: string) => void;
  onComposerKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  mentionCatalog: MentionCatalog;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  threadModelConfig: { provider: ProviderName; model: string } | null;
  reasoningSelector: {
    value: ReasoningEffortValue;
    options: readonly ReasoningEffortValue[];
  } | null;
  onReasoningEffortChange: (value: ReasoningEffortValue) => void;
  modelSelectorDisabled: boolean;
  selectedThreadId: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
  preparingAttachments: boolean;
  submission: ComposerSubmission | null;
  canEditAcceptedSubmission: boolean;
  interruptPending: boolean;
  onRetrySubmission: () => void;
  onEditSubmission: () => void;
  onDismissSubmission: () => void;
  onStop?: () => void;
}) {
  const {
    messageBarOverlayRef,
    composerOverlayMinHeight,
    messageBarHeight,
    inputDisabled,
    transcriptOnly,
    ingestAttachmentFiles,
    pendingAttachments,
    removeAttachment,
    submitComposer,
    busy,
    composerHint,
    composerSubmitState,
    attachmentPickerError,
    composerText,
    setComposerText,
    onComposerKeyDown,
    mentionCatalog,
    placeholder,
    textareaRef,
    fileInputRef,
    handleFileSelect,
    threadModelConfig,
    reasoningSelector,
    onReasoningEffortChange,
    modelSelectorDisabled,
    selectedThreadId,
    modelDisplayNames,
    preparingAttachments,
    submission,
    canEditAcceptedSubmission,
    interruptPending,
    onRetrySubmission,
    onEditSubmission,
    onDismissSubmission,
    onStop,
  } = props;
  const developerMode = useAppStore((s) => s.developerMode);

  return (
    <div
      ref={messageBarOverlayRef}
      data-slot="message-bar-overlay"
      className="absolute bottom-0 left-0 right-0 z-20 flex flex-col bg-gradient-to-t from-panel via-panel/95 to-transparent px-4 pb-4 pt-10 pointer-events-none"
      style={{ minHeight: composerOverlayMinHeight }}
    >
      <div className="relative mx-auto w-full max-w-[56rem] pointer-events-auto">
        {developerMode ? <MessageBarResizer /> : null}
        <MessageComposerRoot
          className="app-surface-opaque w-full max-w-full rounded-[28px] border border-border/55 app-shadow-overlay"
          style={{ "--composer-cap": `${messageBarHeight}px` } as CSSProperties}
          fileDrop={
            inputDisabled || transcriptOnly ? undefined : { onFiles: ingestAttachmentFiles }
          }
        >
          {preparingAttachments && !attachmentPickerError && (
            <div
              data-slot="composer-preparing"
              className="w-full px-3 pt-2.5"
              role="status"
              aria-busy="true"
              aria-live="polite"
            >
              <Progress indeterminate className="h-0.5 rounded-full bg-primary/10" />
              <span className="sr-only">Uploading and preparing message…</span>
            </div>
          )}
          <MessageComposerAttachments
            attachments={pendingAttachments}
            onRemove={removeAttachment}
            className="px-0"
          />
          <MessageComposerSubmissionNotice
            submission={submission}
            onRetry={onRetrySubmission}
            onEdit={onEditSubmission}
            canEditAccepted={canEditAcceptedSubmission}
            onDismiss={onDismissSubmission}
          />
          <MessageComposerForm
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (composerSubmitState.disabled) return;
              submitComposer();
            }}
          >
            <MessageComposerStatus>{composerHint}</MessageComposerStatus>
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
                setValue={setComposerText}
                onKeyDown={onComposerKeyDown}
                onPasteFiles={(files) => void ingestAttachmentFiles(files)}
                disabled={inputDisabled}
                placeholder={placeholder}
                catalog={mentionCatalog}
                ariaLabel="Message input"
                textareaScrollClassName="min-h-14 max-h-[var(--composer-cap)] overflow-y-auto"
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
                  disabled={inputDisabled}
                  className="rounded-full text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                  aria-label="Attach files"
                  title="Attach files"
                >
                  <PaperclipIcon />
                </Button>
                {threadModelConfig ? (
                  <ThreadModelSelector
                    threadId={selectedThreadId}
                    provider={threadModelConfig.provider}
                    model={threadModelConfig.model}
                    modelDisplayNames={modelDisplayNames}
                    disabled={modelSelectorDisabled}
                  />
                ) : null}
                {reasoningSelector ? (
                  <ComposerReasoningSelector
                    value={reasoningSelector.value}
                    options={reasoningSelector.options}
                    disabled={inputDisabled || busy}
                    onChange={onReasoningEffortChange}
                  />
                ) : null}
              </MessageComposerTools>
              <div className="flex shrink-0 items-center gap-2">
                {busy && onStop ? (
                  <MessageComposerStop pending={interruptPending} onStop={onStop} />
                ) : null}
                <MessageComposerSubmit
                  mode={composerSubmitState.mode}
                  status={composerSubmitState.status}
                  disabled={composerSubmitState.disabled}
                />
              </div>
            </MessageComposerFooter>
          </MessageComposerForm>
        </MessageComposerRoot>
      </div>
    </div>
  );
}
