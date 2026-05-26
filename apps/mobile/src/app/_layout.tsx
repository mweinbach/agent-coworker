import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import "../global.css";

import { MobileAppProvider } from "@/providers/MobileAppProvider";
import { SyncCssColorScheme } from "@/theme/sync-css-color-scheme";
import { resolveColorScheme, useAppTheme } from "@/theme/use-app-theme";

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const resolvedScheme = resolveColorScheme(colorScheme);
  const theme = useAppTheme();
  const [fontsLoaded] = useFonts({
    IBMPlexSans: require("../../assets/fonts/IBMPlexSans-Variable.ttf"),
    "IBMPlexSans-Italic": require("../../assets/fonts/IBMPlexSans-Italic-Variable.ttf"),
    IBMPlexMono: require("../../assets/fonts/IBMPlexMono-Regular.ttf"),
    "IBMPlexMono-Medium": require("../../assets/fonts/IBMPlexMono-Medium.ttf"),
    "IBMPlexMono-SemiBold": require("../../assets/fonts/IBMPlexMono-SemiBold.ttf"),
    "IBMPlexMono-Bold": require("../../assets/fonts/IBMPlexMono-Bold.ttf"),
  });

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: theme.background }} />;
  }

  return (
    <SafeAreaProvider>
      <SyncCssColorScheme />
      <ThemeProvider
        value={{
          ...(resolvedScheme === "light" ? DefaultTheme : DarkTheme),
          colors: {
            ...(resolvedScheme === "light" ? DefaultTheme : DarkTheme).colors,
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
