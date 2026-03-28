import type { PropsWithChildren } from "react";
import { Pressable, Text } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

import { SFSymbol } from "./sf-symbol";

type AppButtonProps = PropsWithChildren<{
  variant?: "primary" | "secondary";
  icon?: string;
  onPress?: () => void;
  disabled?: boolean;
}>;

export function AppButton({
  children,
  variant = "primary",
  icon,
  onPress,
  disabled = false,
}: AppButtonProps) {
  const theme = useAppTheme();
  const isPrimary = variant === "primary";

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: isPrimary ? 0 : 1,
        borderColor: theme.border,
        backgroundColor: disabled
          ? theme.surfaceMuted
          : isPrimary
            ? pressed
              ? theme.accent
              : theme.primary
            : pressed
              ? theme.surfaceMuted
              : theme.surfaceElevated,
        paddingHorizontal: 18,
        paddingVertical: 14,
        opacity: disabled ? 0.7 : 1,
        boxShadow: isPrimary && !disabled ? theme.shadow : undefined,
      })}
    >
      {icon ? (
        <SFSymbol
          name={icon}
          size={18}
          color={isPrimary ? theme.primaryText : theme.text}
        />
      ) : null}
      <Text
        selectable
        style={{
          color: isPrimary ? theme.primaryText : theme.text,
          fontSize: 15,
          fontWeight: "700",
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
