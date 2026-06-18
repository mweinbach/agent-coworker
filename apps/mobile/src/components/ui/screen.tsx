import type { PropsWithChildren } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/theme/use-app-theme";

type ScreenProps = PropsWithChildren<{
  scroll?: boolean;
  avoidKeyboard?: boolean;
  className?: string;
  contentStyle?: StyleProp<ViewStyle>;
}>;

export function Screen({ children, scroll = false, avoidKeyboard = false, contentStyle }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const theme = useAppTheme();

  const inner = (
    <View
      style={[
        {
          gap: 18,
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom + 24, 32),
        },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );

  if (!scroll) {
    return <View style={{ flex: 1, backgroundColor: theme.background }}>{inner}</View>;
  }

  const scrollView = (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={{ flexGrow: 1, backgroundColor: theme.background }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  );

  if (avoidKeyboard) {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: theme.background }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {scrollView}
      </KeyboardAvoidingView>
    );
  }

  return scrollView;
}
