import {
  Button as ExpoButton,
  Host,
  Image as ExpoImage,
  Menu as ExpoMenu,
} from "@expo/ui/swift-ui";
import {
  background,
  foregroundStyle,
  frame,
  glassEffect,
  shadow,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { forwardRef, type ComponentRef } from "react";
import { Platform, Pressable, type PressableProps } from "react-native";
import type { SFSymbol as NativeSFSymbol } from "sf-symbols-typescript";
import { useAppTheme } from "@/theme/use-app-theme";
import { SFSymbol } from "./sf-symbol";

type HeaderGlassButtonProps = Omit<PressableProps, "children" | "onPress" | "style"> & {
  icon: string;
  onPress?: () => void;
};

type HeaderGlassMenuAction = {
  title: string;
  icon: string;
  onPress: () => void;
};

type HeaderGlassMenuProps = {
  icon: string;
  actions: HeaderGlassMenuAction[];
};

function headerControlModifiers(color: string) {
  return [
    foregroundStyle(color),
    frame({ width: 38, height: 38 }),
    background("rgba(255, 255, 255, 0.28)", shapes.circle()),
    glassEffect({
      glass: { variant: "regular", interactive: true, tint: "#FFFFFF" },
      shape: "circle",
    }),
    shadow({ radius: 16, x: 0, y: 8, color: "rgba(35, 42, 24, 0.16)" }),
  ];
}

function asNativeSymbol(icon: string): NativeSFSymbol {
  return icon as NativeSFSymbol;
}

export const HeaderGlassButton = forwardRef<ComponentRef<typeof Pressable>, HeaderGlassButtonProps>(
  function HeaderGlassButton(
    {
      icon,
      accessibilityLabel,
      accessibilityRole = "button",
      hitSlop = 8,
      disabled,
      onPress,
      ...pressableProps
    },
    ref,
  ) {
    const theme = useAppTheme();
    const shouldUseGlass = Platform.OS === "ios" && isLiquidGlassAvailable();
    const fallbackGlassFill = theme.isDark
      ? "rgba(238, 240, 220, 0.1)"
      : "rgba(248, 249, 242, 0.58)";
    const fallbackGlassBorder = theme.isDark
      ? "rgba(238, 241, 220, 0.18)"
      : "rgba(255, 255, 255, 0.62)";
    const fallbackGlassShadow = theme.isDark
      ? "0 12px 26px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.12)"
      : "0 12px 26px rgba(35, 42, 24, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.78)";

    if (Platform.OS === "ios") {
      return (
        <Host
          matchContents={{ horizontal: true, vertical: true }}
          pointerEvents={disabled ? "none" : "auto"}
          style={{ width: 44, height: 44 }}
        >
          <ExpoImage
            systemName={asNativeSymbol(icon)}
            size={17}
            color={theme.text}
            onPress={onPress}
            modifiers={headerControlModifiers(theme.text)}
          />
        </Host>
      );
    }

    return (
      <Pressable
        ref={ref}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
        disabled={disabled}
        hitSlop={hitSlop}
        {...pressableProps}
        style={({ pressed }) => ({
          position: "relative",
          width: 38,
          height: 38,
          overflow: "hidden",
          borderRadius: 19,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: fallbackGlassBorder,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: shouldUseGlass ? "transparent" : fallbackGlassFill,
          boxShadow: fallbackGlassShadow,
          opacity: disabled ? 0.5 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        {shouldUseGlass ? (
          <GlassView
            pointerEvents="none"
            glassEffectStyle="clear"
            tintColor={theme.background}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderRadius: 19,
              borderCurve: "continuous",
            }}
          />
        ) : null}
        <SFSymbol name={icon} size={18} color={theme.text} />
      </Pressable>
    );
  },
);

export function HeaderGlassMenu({ icon, actions }: HeaderGlassMenuProps) {
  const theme = useAppTheme();

  return (
    <Host
      matchContents={{ horizontal: true, vertical: true }}
      pointerEvents="auto"
      style={{ width: 44, height: 44 }}
    >
      <ExpoMenu
        label={
          <ExpoImage
            systemName={asNativeSymbol(icon)}
            size={17}
            color={theme.text}
            modifiers={headerControlModifiers(theme.text)}
          />
        }
      >
        {actions.map((action) => (
          <ExpoButton
            key={action.title}
            label={action.title}
            systemImage={asNativeSymbol(action.icon)}
            onPress={action.onPress}
          />
        ))}
      </ExpoMenu>
    </Host>
  );
}
