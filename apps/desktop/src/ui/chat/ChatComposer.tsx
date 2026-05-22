import { AlertTriangleIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import {
  PromptInputAttachmentPreviews,
  PromptInputBody,
  PromptInputFooter,
  PromptInputForm,
  PromptInputRoot,
  PromptInputStatusRow,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../../components/ai-elements/prompt-input";
import { Progress } from "../../components/ui/progress";
import type { ComposerAttachmentFile } from "../../lib/composerAttachments";
import { cn } from "../../lib/utils";
import type { ProviderName } from "../../lib/wsProtocol";
import { MessageBarResizer } from "../layout/MessageBarResizer";
import { type getComposerSubmitState, resolveComposerBusyPolicy } from "./chatLogic";

type ComposerSubmitState = ReturnType<typeof getComposerSubmitState>;

import { DraftThreadModelSelector } from "./DraftThreadModelSelector";
import { ThreadModelIndicator } from "./ThreadModelIndicator";

export function ChatComposer(props: {
  messageBarOverlayRef: RefObject<HTMLDivElement | null>;
  composerOverlayMinHeight: number;
  messageBarHeight: number;
  inputDisabled: boolean;
  transcriptOnly: boolean;
  ingestAttachmentFiles: (files: File[]) => void;
  isUploading: boolean;
  uploadProgress: number;
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
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  threadModelConfig: { provider: ProviderName; model: string } | null;
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
    uploadProgress,
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
    placeholder,
    textareaRef,
    fileInputRef,
    handleFileSelect,
    threadModelConfig,
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
        <PromptInputRoot
          className="w-full max-w-full rounded-[20px] border border-border/50 bg-background/90 app-shadow-overlay backdrop-blur-md"
          style={{ height: messageBarHeight }}
          fileDrop={
            inputDisabled || transcriptOnly
              ? undefined
              : { onFiles: (files) => void ingestAttachmentFiles(files) }
          }
        >
          {isUploading && (
            <div className="w-full mb-3 px-3 pt-2.5">
              <Progress value={uploadProgress} className="h-1 bg-primary/10 rounded-full" />
              <div className="flex items-center gap-2 mt-1.5 px-0.5 text-xs text-muted-foreground select-none font-medium">
                <LoaderCircleIcon className="size-3.5 animate-spin text-primary shrink-0" />
                <span>
                  Uploading and preparing message...{" "}
                  {uploadProgress < 100 ? `${uploadProgress}%` : "Done"}
                </span>
              </div>
            </div>
          )}
          <PromptInputAttachmentPreviews
            attachments={pendingAttachments}
            onRemove={removeAttachment}
            className="px-0"
          />
          <PromptInputForm
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              submitComposer(resolveComposerBusyPolicy(busy));
            }}
          >
            <PromptInputStatusRow>{composerHint}</PromptInputStatusRow>
            <PromptInputBody>
              {attachmentPickerError ? (
                <div className="flex items-center gap-1.5 px-1 pb-1 text-xs text-destructive">
                  <AlertTriangleIcon className="size-3.5 shrink-0" />
                  <span>{attachmentPickerError}</span>
                </div>
              ) : null}
              <PromptInputTextarea
                ref={textareaRef}
                value={composerText}
                disabled={inputDisabled}
                placeholder={placeholder}
                onChange={(event) => setComposerText(event.currentTarget.value)}
                onKeyDown={onComposerKeyDown}
                aria-label="Message input"
              />
            </PromptInputBody>
            <PromptInputFooter className="gap-3 pt-1">
              <PromptInputTools className="gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={inputDisabled}
                  className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:opacity-50"
                  aria-label="Attach files"
                  title="Attach files"
                >
                  <PlusIcon className="h-4 w-4" />
                </button>
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
              </PromptInputTools>
              <div
                className={cn(
                  "flex shrink-0 items-center gap-2",
                  busy ? "opacity-100" : "opacity-80",
                )}
              >
                <PromptInputSubmit
                  mode={composerSubmitState.mode}
                  status={composerSubmitState.status}
                  disabled={composerSubmitState.disabled || preparingAttachments}
                  onStop={onStop}
                />
              </div>
            </PromptInputFooter>
          </PromptInputForm>
        </PromptInputRoot>
      </div>
    </div>
  );
}
