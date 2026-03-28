import { Platform, Pressable } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

import { SFSymbol } from "./sf-symbol";
import { useAppTheme } from "@/theme/use-app-theme";

type HeaderGlassButtonProps = {
  icon: string;
  onPress: () => void;
};

export function HeaderGlassButton({ icon, onPress }: HeaderGlassButtonProps) {
  const theme = useAppTheme();

  if (Platform.OS === "ios" && isLiquidGlassAvailable()) {
    return (
      <GlassView isInteractive style={{ borderRadius: 17 }}>
        <Pressable
          onPress={onPress}
          style={{
            width: 34,
            height: 34,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SFSymbol name={icon} size={18} color={theme.text} />
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.surfaceMuted,
      }}
    >
      <SFSymbol name={icon} size={18} color={theme.text} />
    </Pressable>
  );
}
