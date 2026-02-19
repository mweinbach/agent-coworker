export const designTokens = {
  color: {
    appBg: "var(--app-bg)",
    sidebarBg: "var(--sidebar-bg)",
    panelBg: "var(--panel-bg)",
    border: "var(--border)",
    text: "var(--text)",
    muted: "var(--muted)",
    accent: "var(--accent)",
    danger: "var(--danger)",
    dangerBg: "var(--danger-bg)",
  },
  radius: {
    base: "var(--radius)",
  },
  classes: {
    panelSurface:
      "border border-border/80 bg-card/80 shadow-[0_1px_6px_rgba(0,0,0,0.04)] backdrop-blur-[1px]",
    subtleSurface: "border border-border/70 bg-muted/35",
    mutedText: "text-muted-foreground",
    pageTitle: "text-2xl font-semibold tracking-tight text-foreground",
  },
} as const;

export type DesignTokens = typeof designTokens;
