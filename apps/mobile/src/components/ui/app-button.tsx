import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { palette } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

import { SFSymbol } from "./sf-symbol";

type AppButtonProps = PropsWithChildren<{
  variant?: "primary" | "secondary" | "glass";
  icon?: string;
  fullWidth?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}>;

function glassFallbackColors(isDark: boolean) {
  const colors = isDark ? palette.dark : palette.light;
  return {
    fill: isDark ? "rgba(168, 185, 99, 0.18)" : "rgba(111, 128, 66, 0.16)",
    border: colors.glassBorder,
    shadow: isDark
      ? "0 12px 26px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.12)"
      : "0 12px 26px rgba(35, 42, 24, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.72)",
  };
}

export function AppButton({
  children,
  variant = "primary",
  icon,
  fullWidth = false,
  onPress,
  disabled = false,
}: AppButtonProps) {
  const theme = useAppTheme();
  const isPrimary = variant === "primary";
  const isGlass = variant === "glass";
  const shouldUseGlass = isGlass && Platform.OS === "ios" && isLiquidGlassAvailable();
  const glassColors = glassFallbackColors(theme.isDark);
  const labelColor = isPrimary ? theme.primaryText : theme.text;
  const iconColor = labelColor;

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
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: isGlass || !isPrimary ? 1 : 0,
        borderColor: isGlass ? glassColors.border : theme.border,
        backgroundColor: isGlass
          ? shouldUseGlass
            ? "transparent"
            : pressed
              ? theme.primaryMuted
              : glassColors.fill
          : isPrimary
            ? pressed
              ? theme.primaryMuted
              : theme.primary
            : pressed
              ? theme.surfaceMuted
              : theme.surfaceElevated,
        opacity: disabled ? 0.7 : isGlass && pressed ? 0.88 : 1,
        paddingHorizontal: 18,
        paddingVertical: 14,
        boxShadow: isPrimary ? theme.shadow : isGlass ? glassColors.shadow : undefined,
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
            borderRadius: 16,
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
        {icon ? <SFSymbol name={icon} size={18} color={iconColor} /> : null}
        <Text
          selectable
          style={{
            color: labelColor,
            fontSize: 15,
            fontWeight: "700",
          }}
        >
          {children}
        </Text>
      </View>
    </Pressable>
  );
}
