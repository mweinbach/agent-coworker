export type DesktopRenderMetric =
  | "chat-feed"
  | "desktop-markdown"
  | "feed-derivation"
  | "feed-row"
  | "sidebar-thread-row"
  | "streaming-markdown";

export type DesktopRenderMetricEvent = {
  id?: string;
  metric: DesktopRenderMetric;
  value?: number;
};

type DesktopRenderMetricObserver = (event: DesktopRenderMetricEvent) => void;

let observer: DesktopRenderMetricObserver | null = null;

export function recordDesktopRenderMetric(
  metric: DesktopRenderMetric,
  id?: string,
  value?: number,
): void {
  observer?.({
    ...(id ? { id } : {}),
    metric,
    ...(value !== undefined ? { value } : {}),
  });
}

export function setDesktopRenderMetricObserver(
  nextObserver: DesktopRenderMetricObserver | null,
): () => void {
  observer = nextObserver;
  return () => {
    if (observer === nextObserver) {
      observer = null;
    }
  };
}
