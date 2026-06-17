import { Loader2Icon } from "lucide-react";
import { lazy, Suspense } from "react";

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
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-[360px] items-center justify-center bg-[var(--surface-spreadsheet)] text-sm text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" />
          Opening workbook
        </div>
      }
    >
      <UniverSpreadsheetCanvasImpl {...props} />
    </Suspense>
  );
}
