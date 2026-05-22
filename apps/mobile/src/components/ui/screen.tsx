import type { PropsWithChildren } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollView, View } from "@/tw";

type ScreenProps = PropsWithChildren<{
  scroll?: boolean;
  className?: string;
  contentStyle?: StyleProp<ViewStyle>;
}>;

export function Screen({ children, scroll = false, className, contentStyle }: ScreenProps) {
  const insets = useSafeAreaInsets();

  const inner = (
    <View
      className={scroll ? "gap-xl px-xl pt-[10px]" : "flex-1 gap-xl px-xl pt-[10px]"}
      style={[
        {
          paddingBottom: Math.max(insets.bottom + 24, 32),
        },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );

  if (!scroll) {
    return <View className={`flex-1 bg-surface-window ${className || ""}`}>{inner}</View>;
  }

  return (
    <ScrollView
      className={`flex-1 bg-surface-window ${className || ""}`}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="flex-grow"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  );
}
