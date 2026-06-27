import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { alpha, radius } from "@/theme/tokens";
import { type AppTheme, useAppTheme } from "@/theme/use-app-theme";

import { SFSymbol } from "./sf-symbol";

/**
 * Variants mirror the desktop shadcn Button (`apps/desktop/src/components/ui/button.tsx`):
 * primary→default, plus secondary, destructive, outline, ghost, link. `glass` is a
 * mobile-only iOS Liquid Glass affordance with no desktop counterpart.
 */
type AppButtonVariant =
  | "primary"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link"
  | "glass";

/** Mirrors desktop sizes default/sm/lg (px/py tuned up slightly for touch targets). */
type AppButtonSize = "default" | "sm" | "lg";

type AppButtonProps = PropsWithChildren<{
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  icon?: string;
  fullWidth?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}>;

type VariantStyle = {
  background: string;
  pressedBackground: string;
  label: string;
  borderColor?: string;
  underline?: boolean;
};

function resolveVariant(variant: AppButtonVariant, theme: AppTheme): VariantStyle {
  switch (variant) {
    case "primary":
      return {
        background: theme.primary,
        pressedBackground: theme.primaryMuted,
        label: theme.primaryText,
      };
    case "secondary":
      return {
        background: theme.surfaceElevated,
        pressedBackground: theme.surfaceMuted,
        label: theme.text,
        borderColor: theme.border,
      };
    case "destructive":
      return {
        background: theme.danger,
        pressedBackground: alpha(theme.danger, 0.85),
        // Desktop destructive uses text-white in both schemes.
        label: "#ffffff",
      };
    case "outline":
      return {
        background: "transparent",
        pressedBackground: theme.surfaceMuted,
        label: theme.text,
        borderColor: theme.border,
      };
    case "ghost":
      return {
        background: "transparent",
        pressedBackground: theme.surfaceMuted,
        label: theme.text,
      };
    case "link":
      return {
        background: "transparent",
        pressedBackground: "transparent",
        label: theme.accent,
        underline: true,
      };
    case "glass":
      return {
        background: theme.accentMuted,
        pressedBackground: theme.primaryMuted,
        label: theme.text,
      };
  }
}

const SIZE_STYLE: Record<
  AppButtonSize,
  { paddingHorizontal: number; paddingVertical: number; fontSize: number }
> = {
  default: { paddingHorizontal: 18, paddingVertical: 12, fontSize: 14 },
  sm: { paddingHorizontal: 12, paddingVertical: 8, fontSize: 13 },
  lg: { paddingHorizontal: 24, paddingVertical: 15, fontSize: 15 },
};

function glassShadow(isDark: boolean): string {
  return isDark
    ? "0 12px 26px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.12)"
    : "0 12px 26px rgba(35, 42, 24, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.72)";
}

export function AppButton({
  children,
  variant = "primary",
  size = "default",
  icon,
  fullWidth = false,
  onPress,
  disabled = false,
}: AppButtonProps) {
  const theme = useAppTheme();
  const isGlass = variant === "glass";
  const isPrimary = variant === "primary";
  const shouldUseGlass = isGlass && Platform.OS === "ios" && isLiquidGlassAvailable();
  const v = resolveVariant(variant, theme);
  const sizing = SIZE_STYLE[size];
  const hasBorder = isGlass || v.borderColor !== undefined;
  const borderColor = isGlass ? theme.borderMuted : v.borderColor;
  // Solid variants (and glass) cast the surface shadow; quiet variants stay flat.
  const elevated = isPrimary || variant === "destructive" || isGlass;

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        position: isGlass ? "relative" : undefined,
        overflow: isGlass ? "hidden" : undefined,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: fullWidth ? "stretch" : undefined,
        width: fullWidth ? "100%" : undefined,
        gap: 8,
        borderRadius: isGlass ? radius.card : radius.md,
        borderCurve: "continuous",
        borderWidth: hasBorder ? 1 : 0,
        borderColor,
        backgroundColor:
          isGlass && shouldUseGlass ? "transparent" : pressed ? v.pressedBackground : v.background,
        opacity: disabled ? 0.5 : isGlass && pressed ? 0.88 : 1,
        paddingHorizontal: sizing.paddingHorizontal,
        paddingVertical: sizing.paddingVertical,
        boxShadow: elevated ? (isGlass ? glassShadow(theme.isDark) : theme.shadow) : undefined,
        transform: isGlass && pressed ? [{ scale: 0.985 }] : undefined,
      })}
    >
      {shouldUseGlass ? (
        <GlassView
          pointerEvents="none"
          isInteractive
          glassEffectStyle="regular"
          tintColor={theme.primary}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            borderRadius: radius.card,
            borderCurve: "continuous",
          }}
        />
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {icon ? <SFSymbol name={icon} size={18} color={v.label} /> : null}
        <Text
          selectable
          style={{
            color: v.label,
            fontSize: sizing.fontSize,
            fontWeight: "600",
            textDecorationLine: v.underline ? "underline" : "none",
          }}
        >
          {children}
        </Text>
      </View>
    </Pressable>
  );
}
