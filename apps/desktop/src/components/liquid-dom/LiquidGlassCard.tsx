import {
  Frame,
  Glass,
  GlassContainer,
  Html,
  LiquidCanvas,
  Padding,
} from "@liquid-dom/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export type LiquidDomRuntimeState = "checking" | "available" | "unavailable";

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

type LiquidGlassCardProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  fallbackClassName?: string;
};

type LiquidGlassBackdropProps = {
  className?: string;
};

export function LiquidGlassBackdrop({ className }: LiquidGlassBackdropProps) {
  const runtimeState = useLiquidDomRuntimeState();
  const [renderError, setRenderError] = useState(false);

  if (runtimeState !== "available" || renderError) {
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
        maxDpr={2}
        onError={() => setRenderError(true)}
      >
        <GlassContainer
          blur={22}
          bezelWidth={30}
          thickness={88}
          spacing={16}
          tint={{ r: 1, g: 1, b: 1, a: 0.38 }}
          shadowColor={{ r: 0, g: 0, b: 0, a: 0.18 }}
          shadowOffsetY={18}
          shadowBlur={42}
          specularOpacity={0.7}
          displacementBlur={18}
        >
          <Padding insets={1}>
            <Frame maxWidth={Number.POSITIVE_INFINITY} maxHeight={Number.POSITIVE_INFINITY}>
              <Glass cornerRadius={20} cornerSmoothing={0.72} />
            </Frame>
          </Padding>
        </GlassContainer>
      </LiquidCanvas>
    </div>
  );
}

function LiquidGlassFallback({
  children,
  className,
  contentClassName,
}: Pick<LiquidGlassCardProps, "children" | "className" | "contentClassName">) {
  return (
    <div
      data-liquid-dom-fallback="true"
      className={cn(
        "relative overflow-hidden rounded-xl border border-border/70 bg-card/85 shadow-sm",
        className,
      )}
    >
      <div className={cn("relative z-10 h-full w-full p-5", contentClassName)}>{children}</div>
    </div>
  );
}

export function LiquidGlassCard({
  children,
  className,
  contentClassName,
  fallbackClassName,
}: LiquidGlassCardProps) {
  const runtimeState = useLiquidDomRuntimeState();
  const [renderError, setRenderError] = useState(false);

  if (runtimeState !== "available" || renderError) {
    return (
      <LiquidGlassFallback
        className={cn(className, fallbackClassName)}
        contentClassName={contentClassName}
      >
        {children}
      </LiquidGlassFallback>
    );
  }

  return (
    <div
      data-liquid-dom-card="true"
      className={cn("relative min-h-40 overflow-hidden rounded-xl", className)}
    >
      <LiquidCanvas
        className="absolute inset-0"
        canvasClassName="h-full w-full"
        frameloop="demand"
        maxDpr={2}
        onError={() => setRenderError(true)}
      >
        <GlassContainer
          blur={16}
          bezelWidth={26}
          thickness={72}
          spacing={18}
          tint={{ r: 1, g: 1, b: 1, a: 0.34 }}
          shadowColor={{ r: 0, g: 0, b: 0, a: 0.14 }}
          shadowOffsetY={14}
          shadowBlur={34}
          specularOpacity={0.58}
          displacementBlur={12}
        >
          <Padding insets={1}>
            <Frame maxWidth={Number.POSITIVE_INFINITY} maxHeight={Number.POSITIVE_INFINITY}>
              <Glass cornerRadius={22} cornerSmoothing={0.6}>
                <Html sizing="fill">
                  <div
                    className={cn(
                      "h-full w-full border border-white/20 bg-background/15 p-5 text-foreground",
                      contentClassName,
                    )}
                  >
                    {children}
                  </div>
                </Html>
              </Glass>
            </Frame>
          </Padding>
        </GlassContainer>
      </LiquidCanvas>
    </div>
  );
}
