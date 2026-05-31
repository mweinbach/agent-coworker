import { Loader2Icon } from "lucide-react";
import { lazy, Suspense } from "react";
import { SpreadsheetPreview } from "./SpreadsheetPreview";

const UniverSpreadsheetCanvasImpl = lazy(() =>
  import("./UniverSpreadsheetCanvas").then((module) => ({
    default: module.UniverSpreadsheetCanvas,
  })),
);

type LazyUniverSpreadsheetCanvasProps = {
  path: string;
  compact?: boolean;
};

export function LazyUniverSpreadsheetCanvas(props: LazyUniverSpreadsheetCanvasProps) {
  if (shouldUseLegacySpreadsheetPreviewForTests()) {
    return <SpreadsheetPreview {...props} />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-[360px] items-center justify-center bg-white text-sm text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" />
          Opening workbook
        </div>
      }
    >
      <UniverSpreadsheetCanvasImpl {...props} />
    </Suspense>
  );
}

function shouldUseLegacySpreadsheetPreviewForTests(): boolean {
  const globalWithBun = globalThis as { Bun?: unknown };
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
  return (
    import.meta.env.MODE === "test" ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "test") ||
    userAgent.includes("jsdom") ||
    (Boolean(globalWithBun.Bun) && typeof document !== "undefined" && typeof window !== "undefined")
  );
}
