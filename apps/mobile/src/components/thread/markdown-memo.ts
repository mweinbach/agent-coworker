export type MarkdownRevisionProps = {
  text: string;
  color?: string;
  variant?: "default" | "reasoning";
};

export function areMarkdownRevisionPropsEqual(
  previous: MarkdownRevisionProps,
  next: MarkdownRevisionProps,
): boolean {
  return (
    previous.text === next.text &&
    previous.color === next.color &&
    previous.variant === next.variant
  );
}
