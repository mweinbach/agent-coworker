import {
  FileAudioIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../../components/ui/attachment";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

type FileIdentity = { filename: string; mimeType: string };

function attachmentExtension(filename: string): string | null {
  const parts = filename.trim().split(".");
  if (parts.length < 2) return null;
  const extension = parts.at(-1)?.trim();
  return extension ? extension.toUpperCase() : null;
}

function spreadsheetLabel(item: FileIdentity): string | null {
  const extension = attachmentExtension(item.filename);
  if (extension === "CSV" || item.mimeType === "text/csv") return "CSV spreadsheet";
  if (extension === "ODS" || item.mimeType === "application/vnd.oasis.opendocument.spreadsheet")
    return "Spreadsheet";
  if (
    (extension && ["XLS", "XLSX", "XLSM", "XLSB", "XLT", "XLTX", "XLTM"].includes(extension)) ||
    item.mimeType === "application/vnd.ms-excel" ||
    item.mimeType.startsWith("application/vnd.ms-excel.") ||
    item.mimeType.startsWith("application/vnd.openxmlformats-officedocument.spreadsheetml.")
  )
    return "Excel spreadsheet";
  return null;
}

function attachmentPresentation(item: FileIdentity) {
  const spreadsheet = spreadsheetLabel(item);
  if (spreadsheet) return { label: spreadsheet, Icon: FileSpreadsheetIcon, spreadsheet: true };
  if (
    item.mimeType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(item.filename)
  )
    return { label: "Image", Icon: FileImageIcon };
  if (item.mimeType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(item.filename))
    return { label: "Audio", Icon: FileAudioIcon };
  if (item.mimeType.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm)$/i.test(item.filename))
    return { label: "Video", Icon: FileVideoIcon };
  const extension = attachmentExtension(item.filename);
  let label = extension ? `${extension} file` : "File";
  if (extension === "PDF" || item.mimeType === "application/pdf") label = "PDF document";
  if (extension === "DOC" || extension === "DOCX") label = "Word document";
  if (extension === "PPT" || extension === "PPTX") label = "Presentation";
  return { label, Icon: FileTextIcon };
}

/** Shared file identity for draft and sent attachments. Wrap groups in TooltipProvider. */
export function FileAttachment({
  filename,
  mimeType = "",
  previewUrl,
  children,
}: {
  filename: string;
  mimeType?: string;
  previewUrl?: string | null;
  children?: ReactNode;
}) {
  const { label, Icon, spreadsheet } = attachmentPresentation({ filename, mimeType });
  const extensionIndex = filename.lastIndexOf(".");
  const hasExtension = extensionIndex > 0 && extensionIndex < filename.length - 1;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Sent attachments have no action button to focus; keyboard users still need the full filename. */}
        <div
          tabIndex={children ? undefined : 0}
          className="min-w-0 max-w-full rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Attachment
            size="sm"
            className="w-60 min-w-0 max-w-full flex-nowrap gap-2 border-border/60 bg-muted/40 hover:bg-muted/70"
          >
            <AttachmentMedia
              variant={previewUrl ? "image" : "icon"}
              className={cn(!previewUrl && spreadsheet && "bg-success/15 text-success")}
            >
              {previewUrl ? (
                <img src={previewUrl} alt="" className="size-full object-cover" draggable={false} />
              ) : (
                <Icon
                  className={cn("size-4", !spreadsheet && "text-muted-foreground")}
                  aria-hidden
                />
              )}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle className="flex">
                <span className="truncate">
                  {hasExtension ? filename.slice(0, extensionIndex) : filename}
                </span>
                {hasExtension && <span className="shrink-0">{filename.slice(extensionIndex)}</span>}
              </AttachmentTitle>
              <AttachmentDescription>{label}</AttachmentDescription>
            </AttachmentContent>
            {children}
          </Attachment>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={8}
        // The window background is transparent on macOS; tooltip text needs an opaque surface token.
        className="max-w-[min(24rem,calc(100vw-2rem))] break-all text-left text-(--surface-opaque)"
      >
        {filename}
      </TooltipContent>
    </Tooltip>
  );
}
