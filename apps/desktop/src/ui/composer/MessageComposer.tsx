import {
  AlertTriangleIcon,
  ArrowUpIcon,
  CircleCheckIcon,
  FileAudioIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PencilIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, DragEvent } from "react";
import { forwardRef, useCallback, useState } from "react";
import type { ComposerSubmission } from "../../app/composerSubmission";
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

type MessageComposerSubmissionStatus = "ready" | "pending";
type MessageComposerMode = "send" | "steer-ready" | "steer-pending";

type MessageComposerFileDropOptions = {
  onFiles: (files: File[]) => boolean | Promise<boolean>;
  disabled?: boolean;
};

type FileDropAnnouncement = {
  kind: "error" | "status";
  message: string;
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
  const [dropAnnouncement, setDropAnnouncement] = useState<FileDropAnnouncement | null>(null);
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
      setDropAnnouncement({
        kind: "status",
        message: "File drop ready. Drop files to attach them.",
      });
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
      const files = Array.from(list);
      const fileLabel = files.length === 1 ? "file" : "files";
      setDropAnnouncement({
        kind: "status",
        message: `Adding ${files.length} ${fileLabel}.`,
      });
      void Promise.resolve()
        .then(() => fileDrop.onFiles(files))
        .then((attached) => {
          setDropAnnouncement({
            kind: "status",
            message: attached
              ? `${files.length} ${fileLabel} attached.`
              : `No ${fileLabel} attached.`,
          });
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? ` ${error.message}` : "";
          setDropAnnouncement({
            kind: "error",
            message: `Could not attach ${files.length} ${fileLabel}.${detail}`,
          });
        });
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
        "app-shadow-surface relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col rounded-[28px] border border-border/45 bg-panel p-0",
        dropEnabled && dragActive && "ring-2 ring-primary/30 ring-offset-2 ring-offset-background",
        className,
      )}
    >
      {/* Fieldsets use an internal formatting box; a real flex wrapper pins the footer to the bottom. */}
      <div className="flex min-h-0 w-full flex-1 flex-col px-3 py-2.5">{children}</div>
      <span
        className="sr-only"
        role={dropAnnouncement?.kind === "error" ? "alert" : "status"}
        aria-live={dropAnnouncement?.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {dropAnnouncement?.message}
      </span>
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
  disabled?: boolean;
  className?: string;
};

export function MessageComposerAttachments({
  attachments,
  onRemove,
  disabled = false,
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
                  disabled={disabled}
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
          "flex h-6 min-w-0 shrink-0 items-center px-1 text-xs leading-none text-muted-foreground",
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
  status: MessageComposerSubmissionStatus;
};

export function MessageComposerSubmit({
  className,
  disabled,
  mode = "send",
  status,
  ...props
}: MessageComposerSubmitProps) {
  const steerReady = mode === "steer-ready";
  const steerPending = mode === "steer-pending";

  if (status === "pending") {
    return (
      <Button
        type="button"
        size="icon"
        className={cn(
          "size-10 rounded-full border border-primary/15 bg-primary text-primary-foreground shadow-none hover:bg-primary-hover",
          "disabled:border-primary/15 disabled:bg-primary disabled:text-primary-foreground disabled:opacity-100",
          className,
        )}
        disabled
        aria-label={steerPending ? "Sending guidance to current response" : "Sending message"}
        title={steerPending ? "Sending guidance to current response" : "Sending message"}
        aria-busy="true"
        {...props}
      >
        <LoaderCircleIcon data-icon="send" className="size-4 animate-spin" strokeWidth={2.25} />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      size="icon"
      className={cn(
        steerReady || steerPending
          ? "size-10 rounded-full border border-warning/35 bg-warning text-warning-foreground shadow-none hover:brightness-105"
          : "size-10 rounded-full border border-primary/15 bg-primary text-primary-foreground shadow-none hover:bg-primary-hover",
        steerPending && "animate-pulse",
        "disabled:brightness-100 disabled:border-border/50 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
        className,
      )}
      disabled={disabled}
      aria-label={steerReady || steerPending ? "Send guidance to current response" : "Send message"}
      title={
        steerPending
          ? "Steer sent, waiting for acceptance"
          : steerReady
            ? "Send guidance to the current response"
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

type MessageComposerStopProps = Omit<ComponentProps<typeof Button>, "children" | "type"> & {
  pending?: boolean;
  onStop: () => void;
};

export function MessageComposerStop({
  className,
  disabled,
  pending = false,
  onStop,
  ...props
}: MessageComposerStopProps) {
  return (
    <Button
      type="button"
      size="icon"
      variant="destructive"
      className={cn(
        "size-10 rounded-full border border-destructive/20 bg-destructive text-destructive-foreground shadow-none hover:bg-destructive-hover disabled:border-destructive/20 disabled:bg-destructive disabled:text-destructive-foreground disabled:opacity-100",
        className,
      )}
      disabled={disabled || pending}
      onClick={onStop}
      aria-label={pending ? "Stopping current response" : "Stop current response"}
      title={pending ? "Stopping current response" : "Stop current response"}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? (
        <LoaderCircleIcon data-icon="stop" className="size-4 animate-spin" strokeWidth={2.25} />
      ) : (
        <SquareIcon data-icon="stop" className="size-4" strokeWidth={2.25} />
      )}
    </Button>
  );
}

export function MessageComposerSubmissionNotice({
  submission,
  onRetry,
  onEdit,
  canEditAccepted = true,
  onDismiss,
}: {
  submission: ComposerSubmission | null;
  onRetry: () => void;
  onEdit?: () => void;
  canEditAccepted?: boolean;
  onDismiss: () => void;
}) {
  if (!submission || (submission.phase !== "failed" && submission.phase !== "accepted")) {
    return null;
  }

  const failed = submission.phase === "failed";
  return (
    <div
      data-slot="composer-submission-notice"
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      className={cn(
        "mx-0.5 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
        failed
          ? "border-destructive/30 bg-destructive/8 text-destructive"
          : "border-primary/25 bg-primary/8 text-foreground",
      )}
    >
      {failed ? (
        <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <CircleCheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        {failed
          ? `Message wasn’t sent. ${submission.error ?? "Try again."}`
          : canEditAccepted
            ? "Guidance accepted. Restore it to edit and send as a follow-up."
            : "Guidance accepted. Your newer draft stays unchanged."}
      </span>
      {failed ? (
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          <RotateCcwIcon data-icon="inline-start" />
          Retry exact message
        </Button>
      ) : canEditAccepted && onEdit ? (
        <Button type="button" variant="outline" size="xs" onClick={onEdit}>
          <PencilIcon data-icon="inline-start" />
          Edit as follow-up
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        aria-label={failed ? "Dismiss send failure" : "Dismiss guidance status"}
      >
        <XIcon />
      </Button>
    </div>
  );
}
