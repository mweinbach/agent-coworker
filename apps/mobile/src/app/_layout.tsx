import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MobileAppProvider } from "../providers/MobileAppProvider";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <MobileAppProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(pairing)" />
          <Stack.Screen name="(app)" />
        </Stack>
      </MobileAppProvider>
    </SafeAreaProvider>
  );
}
