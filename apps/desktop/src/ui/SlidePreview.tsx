import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import {
  loadPresentationPreviewResource,
  workspaceFileChangeEvents,
} from "../lib/filePreviewResource";
import { useFileChangeRevision } from "../lib/useFileChangeRevision";
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
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const previousRefreshTrigger = useRef(refreshTrigger);
  const fileChangeRevision = useFileChangeRevision(path);

  const fileName = useMemo(() => path.replace(/\\/g, "/").split("/").pop() || path, [path]);

  useEffect(() => {
    if (!selectedWorkspaceId || !hasActiveWorkspace) {
      setError("No active workspace found.");
      setLoading(false);
      setLoadedPath(path);
      return;
    }

    const controller = new AbortController();
    const loadRevision = fileChangeRevision;
    setLoading(true);
    setError(null);
    setSlide(null);
    setLoadedPath(null);
    void (async () => {
      try {
        const resource = await loadPresentationPreviewResource({
          path,
          workspaceId: selectedWorkspaceId,
          force: refreshKey > 0,
          signal: controller.signal,
          loader: loadPresentationPreview,
        });
        if (
          controller.signal.aborted ||
          workspaceFileChangeEvents.getRevision(path) !== loadRevision
        ) {
          return;
        }
        const response = resource.value;
        if (response.ok && response.slides.length > 0) {
          setSlide(response.slides[0] ?? null);
        } else if (!response.ok) {
          setError(response.error.message || "Failed to render slide.");
        } else {
          setError("Invalid response received from rendering engine.");
        }
        setLoadedPath(path);
        setLoading(false);
      } catch (err) {
        if (
          controller.signal.aborted ||
          workspaceFileChangeEvents.getRevision(path) !== loadRevision
        ) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setLoadedPath(path);
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    fileChangeRevision,
    hasActiveWorkspace,
    loadPresentationPreview,
    path,
    refreshKey,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (Object.is(previousRefreshTrigger.current, refreshTrigger)) return;
    previousRefreshTrigger.current = refreshTrigger;
    setRefreshKey((k) => k + 1);
  }, [refreshTrigger]);

  const loadedCurrentPath = loadedPath === path;
  const visibleLoading = !loadedCurrentPath || loading;
  const visibleError = loadedCurrentPath ? error : null;
  const visibleSlide = loadedCurrentPath ? slide : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-canvas-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground" title={fileName}>
            {fileName}
          </p>
          <p className="text-xs text-muted-foreground">Slide preview</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={visibleLoading}
          className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
        >
          <RefreshCwIcon className={cn("size-3.5", visibleLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border border-border/50 bg-muted/15 p-3">
        {visibleLoading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2Icon className="size-6 text-muted-foreground animate-spin" />
            <p className="text-xs text-muted-foreground">Rendering slide…</p>
          </div>
        ) : visibleError ? (
          <div className="flex max-w-md flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-center">
            <AlertTriangleIcon className="size-6 text-destructive" />
            <h3 className="text-sm font-medium text-foreground">Couldn’t render slide</h3>
            <pre className="max-h-48 w-full overflow-auto rounded-md border border-destructive/20 bg-destructive/5 p-3 text-left font-mono text-xs leading-relaxed text-foreground">
              {visibleError}
            </pre>
          </div>
        ) : visibleSlide ? (
          <img
            src={visibleSlide.pngBase64}
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
