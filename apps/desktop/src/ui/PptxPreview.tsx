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
import { cn } from "../lib/utils";

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

  const fileName = useMemo(() => path.replace(/\\/g, "/").split("/").pop() || path, [path]);

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground" title={fileName}>
            {fileName}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {slides.length > 0
              ? `${slides.length} slide${slides.length === 1 ? "" : "s"}`
              : "Presentation"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {slides.length > 0 ? (
            <div className="flex items-center rounded-md border border-border/60 bg-muted/25 p-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-7",
                  layoutMode === "deck" ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setLayoutMode("deck")}
                title="Deck view"
                aria-label="Deck view"
              >
                <ColumnsIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-7",
                  layoutMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setLayoutMode("grid")}
                title="Grid view"
                aria-label="Grid view"
              >
                <LayoutGridIcon className="size-3.5" />
              </Button>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 pt-2">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Loader2Icon className="size-6 text-muted-foreground animate-spin" />
            <p className="text-xs text-muted-foreground">Rendering slides…</p>
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-3">
            <div className="flex max-w-md flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-center">
              <AlertTriangleIcon className="size-6 text-destructive" />
              <h3 className="text-sm font-medium text-foreground">Couldn’t render presentation</h3>
              <p className="text-xs text-muted-foreground">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefreshKey((k) => k + 1)}
                className="mt-1"
              >
                Try again
              </Button>
            </div>
          </div>
        ) : slides.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            No slides to preview.
          </div>
        ) : layoutMode === "deck" ? (
          <div className="flex min-h-0 flex-1 gap-3">
            <div className="flex w-40 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border/50 pr-2 select-none">
              {slides.map((s, idx) => (
                <button
                  type="button"
                  key={s.slideIndex}
                  onClick={() => setActiveIndex(idx)}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-md border p-1.5 text-left transition-colors",
                    idx === activeIndex
                      ? "border-primary/50 bg-primary/8"
                      : "border-transparent bg-muted/15 hover:border-border/60 hover:bg-muted/30",
                  )}
                >
                  <div className="relative aspect-video w-full overflow-hidden rounded border border-border/40 bg-background">
                    <img
                      src={s.pngBase64}
                      alt={`Slide ${s.slideIndex + 1}`}
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute bottom-0.5 right-0.5 rounded bg-background/85 px-1 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                      {idx + 1}
                    </div>
                  </div>
                  <span className="truncate px-0.5 text-[11px] text-muted-foreground">
                    {s.title || `Slide ${idx + 1}`}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border border-border/50 bg-muted/15 p-3">
                {activeSlide ? (
                  <img
                    src={activeSlide.pngBase64}
                    alt={activeSlide.title || "Selected slide"}
                    className="max-h-full max-w-full select-none object-contain"
                  />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center justify-between gap-2 pt-2">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {activeSlide?.title || `Slide ${activeIndex + 1}`}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="size-7"
                    onClick={handlePrev}
                    disabled={activeIndex === 0}
                    aria-label="Previous slide"
                  >
                    <ChevronLeftIcon className="size-3.5" />
                  </Button>
                  <span className="min-w-10 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
                    {activeIndex + 1} / {slides.length}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="size-7"
                    onClick={handleNext}
                    disabled={activeIndex === slides.length - 1}
                    aria-label="Next slide"
                  >
                    <ChevronRightIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {slides.map((s, idx) => (
                <button
                  type="button"
                  key={s.slideIndex}
                  onClick={() => {
                    setActiveIndex(idx);
                    setLayoutMode("deck");
                  }}
                  className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-muted/10 p-2 text-left transition-colors hover:border-border hover:bg-muted/20"
                >
                  <div className="relative aspect-video overflow-hidden rounded border border-border/50 bg-background">
                    <img
                      src={s.pngBase64}
                      alt={`Slide ${s.slideIndex + 1}`}
                      loading="lazy"
                      className="h-full w-full select-none object-cover"
                    />
                    <div className="absolute bottom-1 right-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                      {idx + 1}
                    </div>
                  </div>
                  <span className="truncate px-0.5 text-xs text-muted-foreground">
                    {s.title || `Slide ${idx + 1}`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
