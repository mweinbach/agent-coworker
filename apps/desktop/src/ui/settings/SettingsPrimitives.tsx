import type { HTMLAttributes, ReactNode } from "react";

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

export function SettingsToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "settings-toolbar flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/55 bg-background/58 px-3 py-2.5",
        className,
      )}
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
    <section
      className={cn(
        "settings-section overflow-hidden rounded-lg border border-border/60 bg-card/80",
        className,
      )}
    >
      {title || description || action ? (
        <div className="grid gap-3 border-b border-border/45 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0 space-y-1">
            {title ? (
              <h2 className="text-[15px] font-semibold leading-tight text-foreground">{title}</h2>
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
      <div className="divide-y divide-border/45">{children}</div>
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

export function SettingsField({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5 text-sm", className)}>
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span> : null}
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
