import { Button, Label, Text } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  frame,
  labelStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import type { SFSymbol } from "sf-symbols-typescript";

export function SectionFooter({ children }: { children: string }) {
  return <Text>{children}</Text>;
}

export function primaryActionButtonModifiers(primaryColor: string) {
  return [
    buttonStyle(isLiquidGlassAvailable() ? "glassProminent" : "borderedProminent"),
    controlSize("large"),
    tint(primaryColor),
    frame({ maxWidth: Number.POSITIVE_INFINITY }),
  ];
}

type PairingActionButtonProps = {
  title: string;
  systemImage: SFSymbol;
  primaryColor: string;
  onPress: () => void;
  disabled?: boolean;
};

export function PairingActionButton({
  title,
  systemImage,
  primaryColor,
  onPress,
  disabled = false,
}: PairingActionButtonProps) {
  return (
    <Button
      onPress={onPress}
      modifiers={[
        ...primaryActionButtonModifiers(primaryColor),
        ...(disabled ? [disabledModifier(true)] : []),
      ]}
    >
      <Label
        title={title}
        systemImage={systemImage}
        modifiers={[labelStyle("titleAndIcon")]}
      />
    </Button>
  );
}
