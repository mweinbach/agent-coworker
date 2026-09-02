import { Spinner } from "../../components/ui/spinner";

export function ScreenLoading({ label }: { label: string }) {
  return (
    <output
      aria-live="polite"
      className="flex h-full items-center justify-center gap-2 bg-panel text-muted-foreground"
    >
      <Spinner className="size-4" aria-hidden="true" />
      <span>{label}</span>
    </output>
  );
}
