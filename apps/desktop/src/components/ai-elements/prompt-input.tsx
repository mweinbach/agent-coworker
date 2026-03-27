import type { ComponentProps, DragEvent } from "react";

import { forwardRef, useCallback, useState } from "react";
import { ArrowUpIcon, FileTextIcon, LoaderCircleIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";
export type PromptInputMode = "send" | "steer-ready" | "steer-pending";

export type PromptInputFileDropOptions = {
  onFiles: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
};

export type PromptInputAttachmentPreviewItem = {
  filename: string;
  mimeType: string;
  previewUrl?: string;
};

type PromptInputRootProps = ComponentProps<"div"> & {
  fileDrop?: PromptInputFileDropOptions;
};

export function PromptInputRoot({ className, fileDrop, ...props }: PromptInputRootProps) {
  const [dragActive, setDragActive] = useState(false);
  const dropEnabled = Boolean(fileDrop) && !fileDrop?.disabled;

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
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
    (event: DragEvent<HTMLDivElement>) => {
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
    (event: DragEvent<HTMLDivElement>) => {
      if (!dropEnabled || !fileDrop) return;
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [dropEnabled, fileDrop],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
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
    <div
      {...props}
      data-slot="prompt-input"
      data-file-drag-active={dragActive ? "" : undefined}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "app-shadow-surface relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col rounded-[28px] border border-border/45 bg-panel px-3 py-2.5 transition-shadow focus-within:shadow-[var(--shadow-overlay)]",
        dropEnabled && dragActive && "ring-2 ring-primary/30 ring-offset-2 ring-offset-background",
        className,
      )}
    />
  );
}

function attachmentPreviewSrc(item: PromptInputAttachmentPreviewItem): string | null {
  if (!item.mimeType.startsWith("image/")) return null;
  return item.previewUrl ?? null;
}

export type PromptInputAttachmentPreviewsProps = {
  attachments: readonly PromptInputAttachmentPreviewItem[];
  onRemove: (index: number) => void;
  className?: string;
};

export function PromptInputAttachmentPreviews({ attachments, onRemove, className }: PromptInputAttachmentPreviewsProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Attached files"
      className={cn("flex w-full min-w-0 flex-col gap-2 px-0.5 pb-1", className)}
    >
      <div className="flex max-w-full flex-wrap gap-2">
        {attachments.map((item, index) => {
          const src = attachmentPreviewSrc(item);
          return (
            <div
              key={`${item.filename}-${index}`}
              className="group relative inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border/50 bg-muted/35 py-1 pl-1 pr-9 text-sm shadow-[inset_0_1px_0_var(--border-glass)]"
            >
              <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background/80 ring-1 ring-border/45">
                {src ? (
                  <img src={src} alt="" className="size-full object-cover" draggable={false} />
                ) : (
                  <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
                )}
              </div>
              <p className="truncate pr-1 text-[13px] font-medium leading-none text-foreground/88" title={item.filename}>
                {item.filename}
              </p>
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-background/88 text-muted-foreground ring-1 ring-border/45 transition-colors hover:text-foreground"
                aria-label={`Remove ${item.filename}`}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const PromptInputForm = forwardRef<HTMLFormElement, ComponentProps<"form">>(function PromptInputForm(
  { className, ...props },
  ref,
) {
  return <form ref={ref} className={cn("flex min-h-0 flex-1 flex-col gap-1.5", className)} {...props} />;
});

export const PromptInputBody = forwardRef<HTMLDivElement, ComponentProps<"div">>(function PromptInputBody(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("flex min-h-0 flex-1 px-0.5", className)} {...props} />;
});

export const PromptInputFooter = forwardRef<HTMLDivElement, ComponentProps<"div">>(function PromptInputFooter(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-0.5 pt-1", className)}
      {...props}
    />
  );
});

export const PromptInputTools = forwardRef<HTMLDivElement, ComponentProps<"div">>(function PromptInputTools(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("flex min-w-0 flex-1 items-center gap-1.5", className)} {...props} />;
});

export const PromptInputTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function PromptInputTextarea(
  { className, rows = 1, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "min-h-[3.25rem] w-full flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-[15px] leading-6 text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground/90 focus:border-0 focus:shadow-none focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:shadow-none focus-visible:outline-none focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
});

type PromptInputSubmitProps = Omit<ComponentProps<typeof Button>, "children" | "type"> & {
  mode?: PromptInputMode;
  onStop?: () => void;
  status: PromptInputStatus;
};

export function PromptInputSubmit({ className, disabled, mode = "send", onStop, status, ...props }: PromptInputSubmitProps) {
  if (status === "submitted" || status === "streaming") {
    return (
      <Button
        type="button"
        size="icon"
        variant="destructive"
        className={cn(
          "size-10 rounded-full border border-border/40 bg-foreground text-background shadow-none hover:bg-foreground/90 disabled:border-border/50 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
          className,
        )}
        disabled={disabled || !onStop}
        onClick={onStop}
        aria-label="Stop generating response"
        {...props}
      >
        <SquareIcon data-icon="stop" />
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
          : "size-10 rounded-full border border-foreground/10 bg-foreground text-background shadow-none hover:bg-foreground/90",
        steerPending && "animate-pulse",
        "disabled:brightness-100 disabled:border-border/50 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
        className,
      )}
      disabled={disabled}
      aria-label={steerReady || steerPending ? "Steer current response" : "Send message"}
      title={steerPending ? "Steer sent, waiting for acceptance" : steerReady ? "Steer the current response" : "Send message"}
      {...props}
    >
      {steerPending ? <LoaderCircleIcon data-icon="send" className="animate-spin" /> : <ArrowUpIcon data-icon="send" />}
    </Button>
  );
}
