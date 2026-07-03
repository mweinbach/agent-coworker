import { type HTMLAttributes, type ReactNode, useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";

export function SettingsPage({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("settings-page mx-auto flex w-full max-w-[1160px] flex-col gap-5", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("settings-section space-y-3", className)}>
      {title || description || action ? (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title ? (
              <h2 className="text-sm font-semibold leading-tight text-foreground">{title}</h2>
            ) : null}
            {description ? (
              <p className="max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {action ? (
            <div className="flex shrink-0 items-center justify-end gap-2">{action}</div>
          ) : null}
        </div>
      ) : null}
      <div className="app-shadow-surface divide-y divide-border/30 overflow-hidden rounded-xl border border-border/75 bg-card/85">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  meta,
  control,
  children,
  danger = false,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  danger?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "settings-row grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
        danger && "bg-destructive/5",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div
          className={cn(
            "text-sm font-medium leading-tight",
            danger ? "text-destructive" : "text-foreground",
          )}
        >
          {title}
        </div>
        {description ? (
          <div className="max-w-[72ch] text-xs leading-relaxed text-muted-foreground">
            {description}
          </div>
        ) : null}
        {meta ? <div className="pt-1 text-xs text-muted-foreground">{meta}</div> : null}
        {children ? <div className="pt-2">{children}</div> : null}
      </div>
      {control ? (
        <div className="flex shrink-0 items-center justify-start sm:justify-end">{control}</div>
      ) : null}
    </div>
  );
}

export function SettingsEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "settings-empty-state flex min-h-44 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/65 bg-background/45 px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground/48 [&_svg]:size-10">{icon}</div> : null}
      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export function SettingsStatTile({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "settings-stat-tile min-w-0 rounded-lg border border-border/60 bg-card/80 px-4 py-3",
        className,
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="pt-1 text-lg font-semibold tabular-nums leading-tight text-foreground">
        {value}
      </div>
      {hint ? <div className="pt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

const ENTITY_ICON_PALETTE = [
  "bg-accent/12 text-accent",
  "bg-success/12 text-success",
  "bg-warning/15 text-warning-foreground",
  "bg-foreground/[0.07] text-foreground/75",
  "bg-accent/20 text-accent",
] as const;

function entityIconPaletteClass(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return ENTITY_ICON_PALETTE[Math.abs(hash) % ENTITY_ICON_PALETTE.length] as string;
}

function isRenderableImageSource(src: string): boolean {
  return src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://");
}

/**
 * Icon for providers, plugins, skills, and MCP servers. Renders an image when
 * `src` is a data URI or URL, a raw glyph (e.g. emoji) when `src` is short
 * text, and otherwise a deterministic letter avatar derived from `name`.
 */
export function EntityIcon({
  src,
  name,
  size = "md",
  className,
}: {
  src?: string | null;
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const sizeClass = size === "sm" ? "size-6" : size === "lg" ? "size-10" : "size-8";
  const textClass = size === "sm" ? "text-[10px]" : size === "lg" ? "text-base" : "text-xs";
  const paletteClass = useMemo(() => entityIconPaletteClass(name), [name]);
  const trimmed = src?.trim() ?? "";

  if (trimmed && !failed && isRenderableImageSource(trimmed)) {
    return (
      <img
        src={trimmed}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
        className={cn(
          "shrink-0 rounded-md border border-border/45 bg-background object-contain",
          sizeClass,
          className,
        )}
      />
    );
  }

  if (trimmed && !failed && trimmed.length <= 3) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md",
          sizeClass,
          size === "lg" ? "text-xl" : "text-sm",
          className,
        )}
      >
        {trimmed}
      </span>
    );
  }

  const initials = name
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => (part[0] ?? "").toUpperCase())
    .join("");

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-md font-semibold",
        sizeClass,
        textClass,
        paletteClass,
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}

export function SettingsStatusPill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 rounded-md px-2 text-[11px] font-medium shadow-none",
        tone === "success" && "border-success/25 bg-success/10 text-success",
        tone === "warning" && "border-warning/35 bg-warning/12 text-warning-foreground",
        tone === "danger" && "border-destructive/25 bg-destructive/10 text-destructive",
        tone === "neutral" && "border-border/65 bg-background/55 text-muted-foreground",
        className,
      )}
    >
      {children}
    </Badge>
  );
}
