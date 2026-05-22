import type { PropsWithChildren } from "react";
import { Pressable, Text, useCSSVariable } from "@/tw";

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
  const isPrimary = variant === "primary";
  const iconColor = useCSSVariable(isPrimary ? "--text-inverse" : "--text-primary");

  const containerClass = isPrimary
    ? "flex-row items-center justify-center gap-sm rounded-card px-xl py-[14px] bg-accent active:opacity-80 shadow-surface"
    : "flex-row items-center justify-center gap-sm rounded-card border border-border-default px-xl py-[14px] bg-surface-card-elevated active:bg-surface-muted-fill";

  const disabledClass = disabled ? "opacity-70 bg-surface-muted-fill" : "";

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      className={`${containerClass} ${disabledClass}`}
    >
      {icon ? <SFSymbol name={icon} size={18} color={iconColor} /> : null}
      <Text
        selectable
        className={
          isPrimary
            ? "text-text-inverse text-[15px] font-bold"
            : "text-text-primary text-[15px] font-bold"
        }
      >
        {children}
      </Text>
    </Pressable>
  );
}
