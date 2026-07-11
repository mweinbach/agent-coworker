export type ChatBottomChrome = "in-flow" | "overlay";

export function resolveChatBottomOffset(options: {
  chrome: ChatBottomChrome;
  measuredOverlayHeight?: number;
  minimumOverlayHeight: number;
}): number {
  if (options.chrome === "in-flow") return 0;
  const measuredHeight = options.measuredOverlayHeight ?? 0;
  if (!Number.isFinite(measuredHeight)) return options.minimumOverlayHeight;
  return Math.max(options.minimumOverlayHeight, Math.ceil(measuredHeight));
}
