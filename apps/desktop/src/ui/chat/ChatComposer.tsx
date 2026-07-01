import { AlertTriangleIcon, LoaderCircleIcon, PaperclipIcon } from "lucide-react";
import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
  RefObject,
} from "react";
import type { ReasoningEffortValue } from "../../app/openaiCompatibleProviderOptions";
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
  MessageComposerSubmit,
  MessageComposerTools,
} from "../composer/MessageComposer";
import { MessageBarResizer } from "../layout/MessageBarResizer";
import { ComposerMentionInput } from "./ComposerMentionInput";
import { ComposerReasoningSelector } from "./ComposerReasoningToggle";
import { type getComposerSubmitState, resolveComposerBusyPolicy } from "./chatLogic";
import type { MentionCatalog } from "./composerMentions";

type ComposerSubmitState = ReturnType<typeof getComposerSubmitState>;

import { DraftThreadModelSelector } from "./DraftThreadModelSelector";
import { ThreadModelIndicator } from "./ThreadModelIndicator";

export function ChatComposer(props: {
  messageBarOverlayRef: Ref<HTMLDivElement>;
  composerOverlayMinHeight: number;
  messageBarHeight: number;
  inputDisabled: boolean;
  transcriptOnly: boolean;
  ingestAttachmentFiles: (files: File[]) => void;
  isUploading: boolean;
  pendingAttachments: ComposerAttachmentFile[];
  removeAttachment: (index: number) => void;
  submitComposer: (busyPolicy: "reject" | "steer") => void;
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
  reasoningSelector: { value: ReasoningEffortValue; options: readonly ReasoningEffortValue[] } | null;
  onReasoningEffortChange: (value: ReasoningEffortValue) => void;
  threadDraft: boolean;
  selectedThreadId: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
  preparingAttachments: boolean;
  onStop?: () => void;
}) {
  const {
    messageBarOverlayRef,
    composerOverlayMinHeight,
    messageBarHeight,
    inputDisabled,
    transcriptOnly,
    ingestAttachmentFiles,
    isUploading,
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
    threadDraft,
    selectedThreadId,
    modelDisplayNames,
    preparingAttachments,
    onStop,
  } = props;

  return (
    <div
      ref={messageBarOverlayRef}
      data-slot="message-bar-overlay"
      className="absolute bottom-0 left-0 right-0 z-20 flex flex-col bg-gradient-to-t from-panel via-panel/95 to-transparent px-4 pb-4 pt-10 pointer-events-none"
      style={{ minHeight: composerOverlayMinHeight }}
    >
      <div className="relative mx-auto w-full max-w-[56rem] pointer-events-auto">
        <MessageBarResizer />
        <MessageComposerRoot
          className="w-full max-w-full rounded-[28px] border border-border/55 bg-background/95 app-shadow-overlay backdrop-blur-md"
          style={{ "--composer-cap": `${messageBarHeight}px` } as CSSProperties}
          fileDrop={
            inputDisabled || transcriptOnly
              ? undefined
              : { onFiles: (files) => void ingestAttachmentFiles(files) }
          }
        >
          {isUploading && !attachmentPickerError && (
            <div
              className="w-full mb-3 px-3 pt-2.5"
              role="status"
              aria-busy="true"
              aria-live="polite"
            >
              <Progress indeterminate className="h-1 bg-primary/10 rounded-full" />
              <div className="flex items-center gap-2 mt-1.5 px-0.5 text-xs text-muted-foreground select-none font-medium">
                <LoaderCircleIcon className="size-3.5 animate-spin text-primary shrink-0" />
                <span>
                  {preparingAttachments ? "Uploading and preparing message…" : "Sending message…"}
                </span>
              </div>
            </div>
          )}
          <MessageComposerAttachments
            attachments={pendingAttachments}
            onRemove={removeAttachment}
            className="px-0"
          />
          <MessageComposerForm
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              submitComposer(resolveComposerBusyPolicy(busy));
            }}
          >
            <MessageComposerStatus>{composerHint}</MessageComposerStatus>
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
                onKeyDown={onComposerKeyDown}
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
                  threadDraft ? (
                    <DraftThreadModelSelector
                      threadId={selectedThreadId}
                      provider={threadModelConfig.provider}
                      model={threadModelConfig.model}
                      modelDisplayNames={modelDisplayNames}
                      disabled={inputDisabled}
                    />
                  ) : (
                    <ThreadModelIndicator
                      provider={threadModelConfig.provider}
                      model={threadModelConfig.model}
                      modelDisplayNames={modelDisplayNames}
                    />
                  )
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
                <MessageComposerSubmit
                  mode={composerSubmitState.mode}
                  status={composerSubmitState.status}
                  disabled={composerSubmitState.disabled || preparingAttachments}
                  onStop={onStop}
                />
              </div>
            </MessageComposerFooter>
          </MessageComposerForm>
        </MessageComposerRoot>
      </div>
    </div>
  );
}
