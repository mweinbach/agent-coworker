import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";

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
        setError(response.error.message || "Failed to render slide module.");
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
    <div className="flex flex-col h-full bg-background text-foreground font-sans p-6 overflow-hidden">
      {/* Header toolbar */}
      <div className="flex items-center justify-between border-b border-border pb-4 mb-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Slide Canvas</h2>
          <p className="text-xs text-muted-foreground">
            Live preview of presentation slide component
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loading}
          className="border-border bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <RefreshCwIcon className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Render Area */}
      <div className="flex-1 flex items-center justify-center relative bg-muted/20 border border-border/60 rounded-2xl overflow-auto p-4 min-h-[300px]">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3">
            <Loader2Icon className="h-8 w-8 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground font-medium">
              Compiling slide component...
            </p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center text-center p-6 max-w-md bg-muted/35 border border-border rounded-xl">
            <AlertTriangleIcon className="h-10 w-10 text-destructive mb-3" />
            <h3 className="text-md font-medium text-foreground mb-2">Rendering Error</h3>
            <pre className="text-xs text-destructive bg-destructive/10 border border-destructive/20 p-4 rounded-lg overflow-x-auto text-left w-full max-h-[250px] font-mono leading-relaxed">
              {error}
            </pre>
          </div>
        ) : slide ? (
          <div className="relative shadow-2xl rounded-lg border border-border/80 max-w-full max-h-full overflow-hidden transition-all duration-300 hover:scale-[1.01]">
            <img
              src={slide.pngBase64}
              alt="Slide Preview"
              className="object-contain max-w-full max-h-[70vh] aspect-[16/9] select-none"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground/85">No preview generated.</p>
        )}
      </div>
    </div>
  );
}
