import { Frame, Glass, GlassContainer, LiquidCanvas, Padding } from "@liquid-dom/react";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive, Slot, Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { useEffect, useState } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type LiquidDomRuntimeState = "checking" | "available" | "unavailable";
type LiquidGlassTone = "clear" | "regular" | "prominent" | "tinted";
type LiquidGlassShape = "panel" | "control" | "capsule" | "sheet";

type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type LiquidGlassOptics = {
  blur: number;
  bezelWidth: number;
  thickness: number;
  spacing: number;
  tint: RgbaColor;
  shadowColor: RgbaColor;
  shadowOffsetY: number;
  shadowBlur: number;
  specularOpacity: number;
  displacementBlur: number;
  displacementFactor: number;
};

const LIQUID_GLASS_MAX_DPR = 2;
const FULL_FRAME_SIZE = Number.POSITIVE_INFINITY;

const opticsByTone: Record<LiquidGlassTone, LiquidGlassOptics> = {
  clear: {
    blur: 10,
    bezelWidth: 18,
    thickness: 58,
    spacing: 14,
    tint: { r: 1, g: 1, b: 1, a: 0.18 },
    shadowColor: { r: 0, g: 0, b: 0, a: 0.1 },
    shadowOffsetY: 10,
    shadowBlur: 24,
    specularOpacity: 0.44,
    displacementBlur: 8,
    displacementFactor: 0.9,
  },
  regular: {
    blur: 16,
    bezelWidth: 26,
    thickness: 72,
    spacing: 18,
    tint: { r: 1, g: 1, b: 1, a: 0.34 },
    shadowColor: { r: 0, g: 0, b: 0, a: 0.14 },
    shadowOffsetY: 14,
    shadowBlur: 34,
    specularOpacity: 0.58,
    displacementBlur: 12,
    displacementFactor: 1,
  },
  prominent: {
    blur: 22,
    bezelWidth: 32,
    thickness: 92,
    spacing: 16,
    tint: { r: 1, g: 1, b: 1, a: 0.44 },
    shadowColor: { r: 0, g: 0, b: 0, a: 0.18 },
    shadowOffsetY: 18,
    shadowBlur: 46,
    specularOpacity: 0.74,
    displacementBlur: 18,
    displacementFactor: 1.12,
  },
  tinted: {
    blur: 18,
    bezelWidth: 28,
    thickness: 78,
    spacing: 18,
    tint: { r: 0.74, g: 0.9, b: 1, a: 0.26 },
    shadowColor: { r: 0, g: 0.08, b: 0.14, a: 0.16 },
    shadowOffsetY: 16,
    shadowBlur: 38,
    specularOpacity: 0.64,
    displacementBlur: 14,
    displacementFactor: 1.04,
  },
};

const shapeRadius: Record<LiquidGlassShape, { radius: number; smoothing: number }> = {
  panel: { radius: 22, smoothing: 0.66 },
  control: { radius: 14, smoothing: 0.72 },
  capsule: { radius: 999, smoothing: 0.84 },
  sheet: { radius: 30, smoothing: 0.7 },
};

function getLiquidDomRuntimeState(): LiquidDomRuntimeState {
  const gpu =
    typeof globalThis.navigator === "undefined"
      ? undefined
      : (globalThis.navigator as Navigator & { gpu?: unknown }).gpu;
  return gpu ? "available" : "unavailable";
}

export function useLiquidDomRuntimeState(): LiquidDomRuntimeState {
  const [state, setState] = useState<LiquidDomRuntimeState>(() => getLiquidDomRuntimeState());

  useEffect(() => {
    setState(getLiquidDomRuntimeState());
  }, []);

  return state;
}

function useReducedLiquidEffects(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") {
      return;
    }
    const transparencyQuery = globalThis.matchMedia("(prefers-reduced-transparency: reduce)");
    const motionQuery = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(transparencyQuery.matches || motionQuery.matches);
    update();
    transparencyQuery.addEventListener("change", update);
    motionQuery.addEventListener("change", update);
    return () => {
      transparencyQuery.removeEventListener("change", update);
      motionQuery.removeEventListener("change", update);
    };
  }, []);

  return reduced;
}

const liquidGlassSurfaceVariants = cva(
  "relative isolate overflow-hidden text-foreground transition-[transform,box-shadow,background-color,border-color] duration-200 ease-out",
  {
    variants: {
      tone: {
        clear: "border border-border/55 bg-background/18 shadow-[var(--shadow-liquid-glass-clear)]",
        regular:
          "border border-border/60 bg-background/28 shadow-[var(--shadow-liquid-glass-regular)]",
        prominent:
          "border border-border/70 bg-background/38 shadow-[var(--shadow-liquid-glass-prominent)]",
        tinted: "border border-border/60 bg-accent/10 shadow-[var(--shadow-liquid-glass-tinted)]",
      },
      shape: {
        panel: "rounded-[22px]",
        control: "rounded-[14px]",
        capsule: "rounded-full",
        sheet: "rounded-[30px]",
      },
      interactive: {
        true: "hover:-translate-y-px active:translate-y-0 active:scale-[0.985]",
        false: "",
      },
    },
    defaultVariants: {
      tone: "regular",
      shape: "panel",
      interactive: false,
    },
  },
);

export type LiquidGlassSurfaceProps = React.ComponentProps<"div"> &
  VariantProps<typeof liquidGlassSurfaceVariants> & {
    contentClassName?: string;
    fallbackClassName?: string;
    canvasClassName?: string;
  };

export function LiquidGlassSurface({
  children,
  className,
  contentClassName,
  fallbackClassName,
  canvasClassName,
  tone = "regular",
  shape = "panel",
  interactive = false,
  ...props
}: LiquidGlassSurfaceProps) {
  const runtimeState = useLiquidDomRuntimeState();
  const reducedEffects = useReducedLiquidEffects();
  const [renderError, setRenderError] = useState(false);
  const effectiveTone = tone ?? "regular";
  const effectiveShape = shape ?? "panel";
  const shapeOptics = shapeRadius[effectiveShape];
  const optics = opticsByTone[effectiveTone];
  const fallbackClasses = cn(
    liquidGlassSurfaceVariants({ tone: effectiveTone, shape: effectiveShape, interactive }),
    reducedEffects
      ? "bg-card/94 shadow-sm backdrop-blur-none"
      : "backdrop-blur-2xl backdrop-saturate-150",
    className,
    fallbackClassName,
  );

  if (runtimeState !== "available" || renderError || reducedEffects) {
    return (
      <div
        data-liquid-glass-surface="fallback"
        data-liquid-dom-fallback="true"
        data-tone={effectiveTone}
        data-shape={effectiveShape}
        className={fallbackClasses}
        {...props}
      >
        <div
          data-liquid-glass-content="true"
          className={cn("relative h-full w-full", contentClassName)}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      data-liquid-glass-surface="enabled"
      data-liquid-dom-card="true"
      data-tone={effectiveTone}
      data-shape={effectiveShape}
      className={cn(
        liquidGlassSurfaceVariants({ tone: effectiveTone, shape: effectiveShape, interactive }),
        className,
      )}
      {...props}
    >
      <LiquidCanvas
        className="absolute inset-0"
        canvasClassName={cn("h-full w-full", canvasClassName)}
        frameloop="demand"
        maxDpr={LIQUID_GLASS_MAX_DPR}
        onError={() => setRenderError(true)}
      >
        <GlassContainer {...optics}>
          <Padding insets={1}>
            <Frame maxWidth={FULL_FRAME_SIZE} maxHeight={FULL_FRAME_SIZE}>
              <Glass cornerRadius={shapeOptics.radius} cornerSmoothing={shapeOptics.smoothing} />
            </Frame>
          </Padding>
        </GlassContainer>
      </LiquidCanvas>
      <div
        data-liquid-glass-content="true"
        className={cn("relative h-full w-full text-foreground", contentClassName)}
      >
        {children}
      </div>
    </div>
  );
}

export type LiquidGlassBackdropProps = {
  className?: string;
  tone?: LiquidGlassTone;
  shape?: LiquidGlassShape;
};

export function LiquidGlassBackdrop({
  className,
  tone = "prominent",
  shape = "panel",
}: LiquidGlassBackdropProps) {
  const runtimeState = useLiquidDomRuntimeState();
  const reducedEffects = useReducedLiquidEffects();
  const [renderError, setRenderError] = useState(false);
  const shapeOptics = shapeRadius[shape];
  const optics = opticsByTone[tone];

  if (runtimeState !== "available" || renderError || reducedEffects) {
    return null;
  }

  return (
    <div
      data-liquid-dom-backdrop="true"
      className={cn("pointer-events-none absolute inset-0", className)}
    >
      <LiquidCanvas
        className="absolute inset-0"
        canvasClassName="h-full w-full"
        frameloop="demand"
        maxDpr={LIQUID_GLASS_MAX_DPR}
        onError={() => setRenderError(true)}
      >
        <GlassContainer {...optics}>
          <Padding insets={1}>
            <Frame maxWidth={FULL_FRAME_SIZE} maxHeight={FULL_FRAME_SIZE}>
              <Glass cornerRadius={shapeOptics.radius} cornerSmoothing={shapeOptics.smoothing} />
            </Frame>
          </Padding>
        </GlassContainer>
      </LiquidCanvas>
    </div>
  );
}

export type LiquidGlassCardProps = LiquidGlassSurfaceProps;

export function LiquidGlassCard({
  className,
  contentClassName,
  children,
  tone = "regular",
  shape = "panel",
  ...props
}: LiquidGlassCardProps) {
  return (
    <LiquidGlassSurface
      data-slot="liquid-glass-card"
      tone={tone}
      shape={shape}
      className={cn("min-h-40", className)}
      contentClassName={cn("flex h-full w-full flex-col gap-6 p-5", contentClassName)}
      {...props}
    >
      {children}
    </LiquidGlassSurface>
  );
}

function LiquidGlassCardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-card-header"
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 has-data-[slot=liquid-glass-card-action]:grid-cols-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

function LiquidGlassCardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-card-title"
      className={cn("text-[15px] font-semibold leading-none tracking-[-0.02em]", className)}
      {...props}
    />
  );
}

function LiquidGlassCardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-card-description"
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

function LiquidGlassCardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function LiquidGlassCardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-card-content"
      className={cn("min-w-0 text-sm", className)}
      {...props}
    />
  );
}

function LiquidGlassCardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-card-footer"
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

const liquidGlassButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[inherit] text-sm font-medium outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "text-foreground hover:text-foreground",
        primary: "text-foreground",
        secondary: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive hover:text-destructive",
        ghost: "text-foreground/76 hover:text-foreground",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type LiquidGlassButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof liquidGlassButtonVariants> & {
    asChild?: boolean;
    glassTone?: LiquidGlassTone;
  };

function LiquidGlassButton({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  glassTone,
  ...props
}: LiquidGlassButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const tone: LiquidGlassTone =
    glassTone ??
    (variant === "primary" ? "prominent" : variant === "secondary" ? "clear" : "regular");

  return (
    <LiquidGlassSurface
      data-slot="liquid-glass-button-shell"
      tone={tone}
      shape="capsule"
      interactive
      className="inline-flex"
      contentClassName="flex"
    >
      <Comp
        data-slot="liquid-glass-button"
        data-variant={variant}
        data-size={size}
        className={cn(liquidGlassButtonVariants({ variant, size, className }))}
        {...props}
      />
    </LiquidGlassSurface>
  );
}

const liquidGlassBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none tracking-[-0.01em] whitespace-nowrap select-none [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "text-foreground",
        secondary: "text-muted-foreground",
        success: "text-success",
        warning: "text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type LiquidGlassBadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof liquidGlassBadgeVariants> & {
    asChild?: boolean;
  };

function LiquidGlassBadge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: LiquidGlassBadgeProps) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <LiquidGlassSurface
      data-slot="liquid-glass-badge-shell"
      tone={variant === "default" ? "regular" : variant === "secondary" ? "clear" : "tinted"}
      shape="capsule"
      className="inline-flex"
      contentClassName="flex"
    >
      <Comp
        data-slot="liquid-glass-badge"
        data-variant={variant}
        className={cn(liquidGlassBadgeVariants({ variant, className }))}
        {...props}
      />
    </LiquidGlassSurface>
  );
}

function LiquidGlassToolbar({
  className,
  contentClassName,
  children,
  ...props
}: LiquidGlassSurfaceProps) {
  return (
    <LiquidGlassSurface
      data-slot="liquid-glass-toolbar"
      tone="regular"
      shape="capsule"
      className={cn("w-fit", className)}
      contentClassName={cn("flex items-center gap-1 p-1", contentClassName)}
      {...props}
    >
      {children}
    </LiquidGlassSurface>
  );
}

function LiquidGlassToolbarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-toolbar-group"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

type LiquidGlassInputProps = Omit<React.ComponentProps<"input">, "className"> & {
  className?: string;
  inputClassName?: string;
  tone?: LiquidGlassTone;
};

function LiquidGlassInput({
  className,
  inputClassName,
  tone = "clear",
  ...props
}: LiquidGlassInputProps) {
  return (
    <LiquidGlassSurface
      data-slot="liquid-glass-input-shell"
      tone={tone}
      shape="control"
      className={cn("h-10", className)}
      contentClassName="flex h-full"
    >
      <input
        data-slot="liquid-glass-input"
        className={cn(
          "h-full w-full rounded-[inherit] bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          inputClassName,
        )}
        {...props}
      />
    </LiquidGlassSurface>
  );
}

function LiquidGlassField({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-field"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function LiquidGlassFieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <Label
      data-slot="liquid-glass-field-label"
      className={cn("text-sm font-medium leading-none text-foreground", className)}
      {...props}
    />
  );
}

function LiquidGlassFieldDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-field-description"
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

function LiquidGlassTabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="liquid-glass-tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/liquid-glass-tabs flex gap-3 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function LiquidGlassTabsList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <LiquidGlassSurface
      data-slot="liquid-glass-tabs-list-shell"
      tone="clear"
      shape="capsule"
      className="w-fit"
      contentClassName="p-1"
    >
      <TabsPrimitive.List
        data-slot="liquid-glass-tabs-list"
        className={cn("inline-flex items-center gap-1", className)}
        {...props}
      >
        {children}
      </TabsPrimitive.List>
    </LiquidGlassSurface>
  );
}

function LiquidGlassTabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="liquid-glass-tabs-trigger"
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap text-foreground/64 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background/54 data-[state=active]:text-foreground data-[state=active]:shadow-[var(--shadow-liquid-glass-selected)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function LiquidGlassTabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="liquid-glass-tabs-content"
      className={cn("min-w-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}

function LiquidGlassDialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="liquid-glass-dialog" {...props} />;
}

function LiquidGlassDialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="liquid-glass-dialog-trigger" {...props} />;
}

function LiquidGlassDialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="liquid-glass-dialog-close" {...props} />;
}

function getPortalContainer() {
  return typeof globalThis.document === "undefined" ? undefined : globalThis.document.body;
}

function LiquidGlassDialogPortal({
  container = getPortalContainer(),
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return (
    <DialogPrimitive.Portal
      data-slot="liquid-glass-dialog-portal"
      container={container}
      {...props}
    />
  );
}

function LiquidGlassDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="liquid-glass-dialog-overlay"
      className={cn(
        "fixed inset-0 z-[var(--desktop-portal-layer)] bg-[var(--liquid-glass-dialog-overlay)] backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function LiquidGlassDialogContent({
  className,
  children,
  onEscapeKeyDown,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <LiquidGlassDialogPortal>
      <LiquidGlassDialogOverlay />
      <DialogPrimitive.Content
        data-slot="liquid-glass-dialog-content"
        className={cn(
          "fixed left-[50%] top-[50%] z-[var(--desktop-portal-layer)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className,
        )}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          event.stopPropagation();
        }}
        {...props}
      >
        <LiquidGlassSurface tone="prominent" shape="sheet" contentClassName="grid gap-4 p-6">
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close
              data-slot="liquid-glass-dialog-close"
              className="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-full text-foreground/62 transition-colors hover:bg-background/35 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          ) : null}
        </LiquidGlassSurface>
      </DialogPrimitive.Content>
    </LiquidGlassDialogPortal>
  );
}

function LiquidGlassDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function LiquidGlassDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="liquid-glass-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function LiquidGlassDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="liquid-glass-dialog-title"
      className={cn("text-lg font-semibold leading-none tracking-[-0.02em]", className)}
      {...props}
    />
  );
}

function LiquidGlassDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="liquid-glass-dialog-description"
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  LiquidGlassBadge,
  LiquidGlassButton,
  LiquidGlassCardAction,
  LiquidGlassCardContent,
  LiquidGlassCardDescription,
  LiquidGlassCardFooter,
  LiquidGlassCardHeader,
  LiquidGlassCardTitle,
  LiquidGlassDialog,
  LiquidGlassDialogClose,
  LiquidGlassDialogContent,
  LiquidGlassDialogDescription,
  LiquidGlassDialogFooter,
  LiquidGlassDialogHeader,
  LiquidGlassDialogOverlay,
  LiquidGlassDialogPortal,
  LiquidGlassDialogTitle,
  LiquidGlassDialogTrigger,
  LiquidGlassField,
  LiquidGlassFieldDescription,
  LiquidGlassFieldLabel,
  LiquidGlassInput,
  LiquidGlassTabs,
  LiquidGlassTabsContent,
  LiquidGlassTabsList,
  LiquidGlassTabsTrigger,
  LiquidGlassToolbar,
  LiquidGlassToolbarGroup,
  liquidGlassBadgeVariants,
  liquidGlassButtonVariants,
  liquidGlassSurfaceVariants,
};
