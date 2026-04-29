import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MobileAppProvider } from "@/providers/MobileAppProvider";
import { useAppTheme } from "@/theme/use-app-theme";

export default function RootLayout() {
  const colorScheme = useColorScheme();
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
