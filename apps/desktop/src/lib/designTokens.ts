export const designTokens = {
  color: {
    appBg: "var(--app-bg)",
    sidebarBg: "var(--sidebar-bg)",
    panelBg: "var(--panel-bg)",
    border: "var(--border-default)",
    text: "var(--text-primary)",
    muted: "var(--text-muted)",
    accent: "var(--accent)",
    danger: "var(--danger)",
    dangerBg: "var(--danger-bg)",
  },
  radius: {
    base: "var(--radius)",
  },
  classes: {
    panelSurface:
      "border border-border/65 bg-card/92 shadow-none backdrop-blur-[1px]",
    subtleSurface: "border border-border/60 bg-muted/20",
    mutedText: "text-muted-foreground",
    pageTitle: "text-[1.75rem] font-semibold tracking-tight text-foreground",
  },
} as const;

export type DesignTokens = typeof designTokens;
