import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { validatePairingPayload } from "@/features/pairing/qrValidation";
import { useAppTheme } from "@/theme/use-app-theme";

export default function PairingScanScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedPayload, setScannedPayload] = useState<string | null>(null);
  const connectWithQr = usePairingStore((state) => state.connectWithQr);

  const granted = permission?.granted ?? false;

  async function onBarcodeScanned(result: BarcodeScanningResult) {
    if (scannedPayload) {
      return;
    }
    const parsed = validatePairingPayload(result.data);
    if (!parsed.success) {
      Alert.alert("Invalid QR", parsed.error);
      return;
    }
    setScannedPayload(JSON.stringify(parsed.data, null, 2));
    try {
      await connectWithQr(parsed.data);
      router.replace("/(app)/(tabs)/(threads)");
    } catch (error) {
      Alert.alert(
        "Pairing failed",
        error instanceof Error ? error.message : "Could not start the secure transport session.",
      );
    }
  }

  return (
    <Screen scroll>
      <SectionCard
        title="Scan your computer"
        description="On your computer, open Cowork Desktop and show the QR from the remote access screen, then point this camera at it."
        action={<StatusPill label={granted ? "camera ready" : "permission needed"} tone={granted ? "success" : "warning"} />}
      >
        {!granted ? (
          <View style={{ gap: 12 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
              Cowork Mobile needs camera access to scan the pairing code. You can grant it now and continue.
            </Text>
            <Pressable
              onPress={() => {
                void requestPermission();
              }}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 18,
                paddingVertical: 11,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Grant camera access</Text>
            </Pressable>
          </View>
        ) : (
          <View
            style={{
              overflow: "hidden",
              borderRadius: 28,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.backgroundMuted,
            }}
          >
            <CameraView
              style={{ height: 430, width: "100%" }}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
              onBarcodeScanned={onBarcodeScanned}
            />
          </View>
        )}
      </SectionCard>

      <SectionCard
        title="Last scanned payload"
        description="Useful when debugging relay handoffs or validating the QR contents."
      >
        <Text
          selectable
          style={{
            color: scannedPayload ? theme.text : theme.textTertiary,
            fontSize: 12,
            lineHeight: 18,
            fontVariant: ["tabular-nums"],
          }}
        >
          {scannedPayload ?? "No QR scanned yet."}
        </Text>
      </SectionCard>
    </Screen>
  );
}
