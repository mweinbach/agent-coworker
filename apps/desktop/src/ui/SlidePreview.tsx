import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

type SlidePreviewProps = {
  path: string;
  refreshTrigger?: unknown;
};

export function SlidePreview({ path, refreshTrigger }: SlidePreviewProps) {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const loadPresentationPreview = useAppStore((s) => s.loadPresentationPreview);

  const hasActiveWorkspace = useMemo(
    () => workspaces.some((w) => w.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );

  const [slide, setSlide] = useState<{ pngBase64: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const previousRefreshTrigger = useRef(refreshTrigger);

  const fileName = useMemo(() => path.replace(/\\/g, "/").split("/").pop() || path, [path]);

  const loadSlide = useCallback(async () => {
    if (!selectedWorkspaceId || !hasActiveWorkspace) {
      setError("No active workspace found.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    if (refreshKey > 0) {
      setSlide(null);
    }
    try {
      const response = await loadPresentationPreview(path);

      if (response?.ok && response.slides && response.slides.length > 0) {
        setSlide(response.slides[0]);
      } else if (response && !response.ok && response.error) {
        setError(response.error.message || "Failed to render slide.");
      } else {
        setError("Invalid response received from rendering engine.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hasActiveWorkspace, path, refreshKey, loadPresentationPreview, selectedWorkspaceId]);

  useEffect(() => {
    if (Object.is(previousRefreshTrigger.current, refreshTrigger)) return;
    previousRefreshTrigger.current = refreshTrigger;
    setRefreshKey((k) => k + 1);
  }, [refreshTrigger]);

  useEffect(() => {
    loadSlide();
  }, [loadSlide]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-canvas-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground" title={fileName}>
            {fileName}
          </p>
          <p className="text-[11px] text-muted-foreground">Slide preview</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loading}
          className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border border-border/50 bg-muted/15 p-3">
        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2Icon className="size-6 text-muted-foreground animate-spin" />
            <p className="text-xs text-muted-foreground">Rendering slide…</p>
          </div>
        ) : error ? (
          <div className="flex max-w-md flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-center">
            <AlertTriangleIcon className="size-6 text-destructive" />
            <h3 className="text-sm font-medium text-foreground">Couldn’t render slide</h3>
            <pre className="max-h-48 w-full overflow-auto rounded-md border border-destructive/20 bg-destructive/5 p-3 text-left font-mono text-[11px] leading-relaxed text-foreground">
              {error}
            </pre>
          </div>
        ) : slide ? (
          <img
            src={slide.pngBase64}
            alt="Slide preview"
            className="max-h-full max-w-full select-none object-contain"
          />
        ) : (
          <p className="text-xs text-muted-foreground">No preview generated.</p>
        )}
      </div>
    </div>
  );
}
