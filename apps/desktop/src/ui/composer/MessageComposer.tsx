import {
  ArrowUpIcon,
  FileAudioIcon,
  FileTextIcon,
  LoaderCircleIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, DragEvent } from "react";
import { forwardRef, useCallback, useState } from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../../components/ui/attachment";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

type MessageComposerSubmissionStatus = "ready" | "pending" | "submitted" | "streaming" | "error";
type MessageComposerMode = "send" | "steer-ready" | "steer-pending";

type MessageComposerFileDropOptions = {
  onFiles: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
};

export type MessageComposerAttachmentItem = {
  filename: string;
  mimeType: string;
  previewUrl?: string;
};

type MessageComposerRootProps = ComponentProps<"fieldset"> & {
  fileDrop?: MessageComposerFileDropOptions;
};

export function MessageComposerRoot({
  className,
  fileDrop,
  children,
  ...props
}: MessageComposerRootProps) {
  const [dragActive, setDragActive] = useState(false);
  const dropEnabled = Boolean(fileDrop) && !fileDrop?.disabled;

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLFieldSetElement>) => {
      if (!dropEnabled || !fileDrop) return;
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      const related = event.relatedTarget as Node | null;
      if (related && event.currentTarget.contains(related)) return;
      setDragActive(true);
    },
    [dropEnabled, fileDrop],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLFieldSetElement>) => {
      if (!dropEnabled || !fileDrop) return;
      event.preventDefault();
      event.stopPropagation();
      const related = event.relatedTarget as Node | null;
      if (related && event.currentTarget.contains(related)) return;
      setDragActive(false);
    },
    [dropEnabled, fileDrop],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLFieldSetElement>) => {
      if (!dropEnabled || !fileDrop) return;
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [dropEnabled, fileDrop],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLFieldSetElement>) => {
      if (!dropEnabled || !fileDrop) return;
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
      const list = event.dataTransfer.files;
      if (!list || list.length === 0) return;
      void Promise.resolve(fileDrop.onFiles(Array.from(list)));
    },
    [dropEnabled, fileDrop],
  );

  return (
    <fieldset
      {...props}
      aria-label="Message composer"
      data-slot="message-composer"
      data-file-drag-active={dragActive ? "" : undefined}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "app-shadow-surface relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col rounded-[28px] border border-border/45 bg-panel p-0 transition-shadow focus-within:shadow-[var(--shadow-overlay)]",
        dropEnabled && dragActive && "ring-2 ring-primary/30 ring-offset-2 ring-offset-background",
        className,
      )}
    >
      {/* Fieldsets use an internal formatting box; a real flex wrapper pins the footer to the bottom. */}
      <div className="flex min-h-0 w-full flex-1 flex-col px-3 py-2.5">{children}</div>
    </fieldset>
  );
}

function attachmentPreviewSrc(item: MessageComposerAttachmentItem): string | null {
  if (!item.mimeType.startsWith("image/")) return null;
  return item.previewUrl ?? null;
}

function attachmentExtension(filename: string): string | null {
  const parts = filename.trim().split(".");
  if (parts.length < 2) return null;
  const extension = parts.at(-1)?.trim();
  return extension ? extension.toUpperCase() : null;
}

function attachmentTypeLabel(item: MessageComposerAttachmentItem): string {
  if (item.mimeType.startsWith("audio/")) {
    return attachmentExtension(item.filename) ?? "AUDIO";
  }
  if (item.mimeType === "application/octet-stream") {
    return attachmentExtension(item.filename) ?? "FILE";
  }
  return item.mimeType.split("/", 1)[0]?.toUpperCase() || "File";
}

function attachmentPreviewIcon(item: MessageComposerAttachmentItem) {
  if (item.mimeType.startsWith("audio/")) {
    return <FileAudioIcon className="size-3.5 text-muted-foreground" aria-hidden />;
  }
  return <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />;
}

function keyedComposerAttachments(attachments: readonly MessageComposerAttachmentItem[]) {
  const occurrences = new Map<string, number>();
  return attachments.map((item) => {
    const signature = `${item.filename}:${item.mimeType}:${item.previewUrl ?? ""}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return { item, key: `${signature}:${occurrence}` };
  });
}

export type MessageComposerAttachmentsProps = {
  attachments: readonly MessageComposerAttachmentItem[];
  onRemove: (index: number) => void;
  className?: string;
};

export function MessageComposerAttachments({
  attachments,
  onRemove,
  className,
}: MessageComposerAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <section
      aria-label="Attached files"
      className={cn("flex w-full min-w-0 flex-col gap-2 px-0.5 pb-1", className)}
    >
      <AttachmentGroup className="flex-wrap overflow-visible py-0">
        {keyedComposerAttachments(attachments).map(({ item, key }, index) => {
          const src = attachmentPreviewSrc(item);
          return (
            <Attachment key={key} size="sm" className="min-w-0 max-w-full bg-background/70">
              <AttachmentMedia variant={src ? "image" : "icon"}>
                {src ? (
                  <img src={src} alt="" className="size-full object-cover" draggable={false} />
                ) : (
                  attachmentPreviewIcon(item)
                )}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={item.filename}>{item.filename}</AttachmentTitle>
                <AttachmentDescription>{attachmentTypeLabel(item)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  type="button"
                  onClick={() => onRemove(index)}
                  aria-label={`Remove ${item.filename}`}
                >
                  <XIcon />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          );
        })}
      </AttachmentGroup>
    </section>
  );
}

export const MessageComposerForm = forwardRef<HTMLFormElement, ComponentProps<"form">>(
  function MessageComposerForm({ className, ...props }, ref) {
    return (
      <form
        ref={ref}
        className={cn("flex min-h-0 flex-1 flex-col gap-1.5", className)}
        {...props}
      />
    );
  },
);

export const MessageComposerBody = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function MessageComposerBody({ className, ...props }, ref) {
    return (
      <div ref={ref} className={cn("flex min-h-0 flex-1 flex-col px-0.5", className)} {...props} />
    );
  },
);

export const MessageComposerFooter = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function MessageComposerFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-0.5 pt-1",
          className,
        )}
        {...props}
      />
    );
  },
);

export const MessageComposerStatus = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function MessageComposerStatus({ className, children, ...props }, ref) {
    if (!children) return null;
    return (
      <div
        ref={ref}
        data-slot="message-composer-status"
        className={cn(
          "flex h-6 min-w-0 shrink-0 items-center px-1 text-[11px] leading-none text-muted-foreground",
          className,
        )}
        {...props}
      >
        <span className="block min-w-0 truncate">{children}</span>
      </div>
    );
  },
);

export const MessageComposerTools = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function MessageComposerTools({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex min-w-0 flex-1 items-center gap-1.5", className)}
        {...props}
      />
    );
  },
);

export const MessageComposerTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(
  function MessageComposerTextarea({ className, rows = 1, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          "field-sizing-content min-h-[4.5rem] w-full flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-[15px] leading-6 text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground/90 focus:border-0 focus:shadow-none focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:shadow-none focus-visible:outline-none focus-visible:ring-0",
          className,
        )}
        {...props}
      />
    );
  },
);

type MessageComposerSubmitProps = Omit<ComponentProps<typeof Button>, "children" | "type"> & {
  mode?: MessageComposerMode;
  onStop?: () => void;
  status: MessageComposerSubmissionStatus;
};

export function MessageComposerSubmit({
  className,
  disabled,
  mode = "send",
  onStop,
  status,
  ...props
}: MessageComposerSubmitProps) {
  if (status === "submitted" || status === "streaming") {
    return (
      <Button
        type="button"
        size="icon"
        variant="destructive"
        className={cn(
          "size-10 rounded-full border border-destructive/20 bg-destructive text-destructive-foreground shadow-none hover:bg-destructive/90 disabled:border-border/50 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
          className,
        )}
        disabled={disabled || !onStop}
        onClick={onStop}
        aria-label="Stop generating response"
        {...props}
      >
        <SquareIcon data-icon="stop" className="size-4" strokeWidth={2.25} />
      </Button>
    );
  }

  if (status === "pending") {
    return (
      <Button
        type="button"
        size="icon"
        className={cn(
          "size-10 rounded-full border border-primary/15 bg-primary text-primary-foreground shadow-none hover:bg-primary/85",
          "disabled:border-primary/15 disabled:bg-primary disabled:text-primary-foreground disabled:opacity-100",
          className,
        )}
        disabled
        aria-label="Sending message"
        title="Sending message"
        {...props}
      >
        <LoaderCircleIcon data-icon="send" className="size-4 animate-spin" strokeWidth={2.25} />
      </Button>
    );
  }

  const steerReady = mode === "steer-ready";
  const steerPending = mode === "steer-pending";

  return (
    <Button
      type="submit"
      size="icon"
      className={cn(
        steerReady || steerPending
          ? "size-10 rounded-full border border-warning/35 bg-warning text-warning-foreground shadow-none hover:brightness-105"
          : "size-10 rounded-full border border-primary/15 bg-primary text-primary-foreground shadow-none hover:bg-primary/85",
        steerPending && "animate-pulse",
        "disabled:brightness-100 disabled:border-border/50 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
        className,
      )}
      disabled={disabled}
      aria-label={steerReady || steerPending ? "Steer current response" : "Send message"}
      title={
        steerPending
          ? "Steer sent, waiting for acceptance"
          : steerReady
            ? "Steer the current response"
            : "Send message"
      }
      {...props}
    >
      {steerPending ? (
        <LoaderCircleIcon data-icon="send" className="size-4 animate-spin" strokeWidth={2.25} />
      ) : (
        <ArrowUpIcon data-icon="send" className="size-4" strokeWidth={2.25} />
      )}
    </Button>
  );
}
