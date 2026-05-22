import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ColumnsIcon,
  LayoutGridIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";

type PptxPreviewProps = {
  path: string;
};

type PresentationSlide = {
  slideIndex: number;
  slideId?: string;
  title?: string;
  pngBase64: string;
};

export function PptxPreview({ path }: PptxPreviewProps) {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const loadPresentationPreview = useAppStore((s) => s.loadPresentationPreview);

  const hasActiveWorkspace = useMemo(
    () => workspaces.some((w) => w.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );

  const [slides, setSlides] = useState<PresentationSlide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [layoutMode, setLayoutMode] = useState<"deck" | "grid">("deck");

  const loadPresentation = useCallback(async () => {
    const _forceReload = refreshKey;
    if (!selectedWorkspaceId || !hasActiveWorkspace) {
      setError("No active workspace found.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await loadPresentationPreview(path);

      if (response?.ok && response.slides) {
        setSlides(response.slides);
        setActiveIndex(0);
      } else if (response && !response.ok && response.error) {
        setError(response.error.message || "Failed to render PowerPoint deck.");
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
    loadPresentation();
  }, [loadPresentation]);

  const activeSlide = slides[activeIndex];

  const handlePrev = useCallback(() => {
    setActiveIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);

  const handleNext = useCallback(() => {
    setActiveIndex((prev) => (prev < slides.length - 1 ? prev + 1 : prev));
  }, [slides.length]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground font-sans p-6 overflow-hidden">
      {/* Header Toolbar */}
      <div className="flex items-center justify-between border-b border-border pb-4 mb-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Presentation Preview
          </h2>
          <p className="text-xs text-muted-foreground truncate max-w-md">
            {path.replace(/\\/g, "/").split("/").pop()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {slides.length > 0 && (
            <div className="flex items-center border border-border rounded-lg p-0.5 bg-muted/30 mr-2">
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-8 ${layoutMode === "deck" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => setLayoutMode("deck")}
                title="Deck Viewer Layout"
              >
                <ColumnsIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-8 ${layoutMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => setLayoutMode("grid")}
                title="Grid Layout"
              >
                <LayoutGridIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
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
      </div>

      {/* Main Preview Container */}
      <div className="flex-1 min-h-0 flex relative">
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <Loader2Icon className="h-8 w-8 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground font-medium">
              Generating presentation slides...
            </p>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center justify-center text-center p-6 max-w-md bg-muted/30 border border-border rounded-xl">
              <AlertTriangleIcon className="h-10 w-10 text-destructive mb-3" />
              <h3 className="text-md font-medium text-foreground mb-2">Rendering Error</h3>
              <p className="text-sm text-muted-foreground mb-4">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefreshKey((k) => k + 1)}
                className="border-border bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
              >
                Try Again
              </Button>
            </div>
          </div>
        ) : slides.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground/80 text-sm">
            No slides to preview.
          </div>
        ) : layoutMode === "deck" ? (
          /* Sidebar + Slide Viewer Layout */
          <div className="flex-1 flex min-h-0 gap-6">
            {/* Sidebar Thumbnails */}
            <div className="w-56 flex flex-col gap-3 overflow-y-auto pr-2 border-r border-border/40 select-none">
              {slides.map((s, idx) => (
                <button
                  type="button"
                  key={s.slideIndex}
                  onClick={() => setActiveIndex(idx)}
                  className={`text-left group flex flex-col gap-1.5 p-2 rounded-xl border transition-all duration-200 w-full ${
                    idx === activeIndex
                      ? "border-primary bg-primary/10"
                      : "border-border/40 bg-muted/10 hover:border-border"
                  }`}
                >
                  <div className="relative aspect-[16/9] bg-background border border-border/40 rounded-lg overflow-hidden w-full">
                    <img
                      src={s.pngBase64}
                      alt={`Slide ${s.slideIndex + 1}`}
                      className="object-cover w-full h-full"
                    />
                    <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-medium text-muted-foreground">
                      {idx + 1}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground truncate px-1 group-hover:text-foreground block w-full">
                    {s.title || `Slide ${idx + 1}`}
                  </span>
                </button>
              ))}
            </div>

            {/* Main Full-Size Slide Viewer */}
            <div className="flex-1 flex flex-col min-h-0 relative bg-muted/20 border border-border/40 rounded-2xl p-6">
              <div className="flex-1 flex items-center justify-center relative min-h-[300px]">
                {activeSlide ? (
                  <div className="relative shadow-2xl rounded-xl border border-border/60 max-w-full max-h-full overflow-hidden transition-all duration-300 hover:scale-[1.005]">
                    <img
                      src={activeSlide.pngBase64}
                      alt={activeSlide.title || "Selected Slide"}
                      className="object-contain max-w-full max-h-[60vh] aspect-[16/9] select-none"
                    />
                  </div>
                ) : null}
              </div>

              {/* Slider controls and Metadata */}
              <div className="flex items-center justify-between border-t border-border/60 pt-4 mt-6">
                <span className="text-sm font-medium text-muted-foreground">
                  {activeSlide?.title || `Slide ${activeIndex + 1}`}
                </span>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 border-border bg-muted/30 text-muted-foreground hover:bg-muted/50 disabled:opacity-30"
                    onClick={handlePrev}
                    disabled={activeIndex === 0}
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                  </Button>
                  <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                    {activeIndex + 1} / {slides.length}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 border-border bg-muted/30 text-muted-foreground hover:bg-muted/50 disabled:opacity-30"
                    onClick={handleNext}
                    disabled={activeIndex === slides.length - 1}
                  >
                    <ChevronRightIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Grid Layout View */
          <div className="flex-1 overflow-y-auto min-h-0 pr-1">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-6">
              {slides.map((s, idx) => (
                <div
                  key={s.slideIndex}
                  className="flex flex-col gap-2 p-3 rounded-2xl border border-border/40 bg-muted/10 hover:border-border transition-all duration-300 hover:translate-y-[-2px] group"
                >
                  <div className="relative aspect-[16/9] bg-background border border-border/60 rounded-xl overflow-hidden shadow-md">
                    <img
                      src={s.pngBase64}
                      alt={`Slide ${s.slideIndex + 1}`}
                      className="object-cover w-full h-full select-none"
                    />
                    <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/70 text-[11px] font-semibold text-muted-foreground">
                      {idx + 1}
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-muted-foreground truncate px-1 mt-1 group-hover:text-foreground">
                    {s.title || `Slide ${idx + 1}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
