import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { Stack } from "expo-router";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MobileAppProvider } from "@/providers/MobileAppProvider";
import { useAppTheme } from "@/theme/use-app-theme";

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = useAppTheme();

  return (
    <SafeAreaProvider>
      <ThemeProvider
        value={{
          ...(colorScheme === "light" ? DefaultTheme : DarkTheme),
          colors: {
            ...(colorScheme === "light" ? DefaultTheme : DarkTheme).colors,
            background: theme.background,
            card: theme.surface,
            border: theme.border,
            primary: theme.primary,
            text: theme.text,
          },
        }}
      >
        <MobileAppProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(pairing)" />
            <Stack.Screen name="(app)" />
          </Stack>
        </MobileAppProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
