import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";

import { GroupedScreen, GroupedSection } from "@/components/pairing/grouped-list";
import { AppButton } from "@/components/ui/app-button";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { validatePairingPayload } from "@/features/pairing/qrValidation";
import { createPairingScanHandler } from "@/features/pairing/scanHandler";
import { alpha } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

export function PairingScanFallback() {
  const router = useRouter();
  const theme = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedPayload, setScannedPayload] = useState<string | null>(null);
  const [manualPayload, setManualPayload] = useState("");
  const connectionState = usePairingStore((state) => state.connectionState);
  const connectWithQr = usePairingStore((state) => state.connectWithQr);
  const scanHandlerRef = useRef<ReturnType<typeof createPairingScanHandler> | null>(null);

  const granted = permission?.granted ?? false;
  const pairingInFlight =
    scannedPayload !== null &&
    (connectionState.status === "pairing" || connectionState.status === "connecting");

  if (!scanHandlerRef.current) {
    scanHandlerRef.current = createPairingScanHandler({
      validatePairingPayload,
      connectWithQr,
      setScannedPayload,
      onSuccess: () => {
        router.replace("/(app)/(tabs)/threads");
      },
      onInvalidPayload: (message) => {
        Alert.alert("Invalid QR", message);
      },
      onPairingError: (message) => {
        Alert.alert("Pairing failed", message);
      },
    });
  }

  async function onBarcodeScanned(result: BarcodeScanningResult) {
    await scanHandlerRef.current?.handleScan(result);
  }

  async function pairManualPayload() {
    const payload = manualPayload.trim();
    if (!payload || pairingInFlight) {
      return;
    }
    await scanHandlerRef.current?.handleScan({ data: payload });
  }

  return (
    <GroupedScreen>
      <GroupedSection footer="Point your camera at the QR code shown in Cowork Desktop under Remote Access.">
        {!granted ? (
          <View style={{ padding: 12 }}>
            <AppButton
              fullWidth
              variant="glass"
              icon="camera.fill"
              onPress={() => {
                void requestPermission();
              }}
            >
              Allow Camera Access
            </AppButton>
          </View>
        ) : (
          <View
            style={{
              overflow: "hidden",
              backgroundColor: theme.backgroundMuted,
            }}
          >
            <CameraView
              style={{ height: 320, width: "100%" }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={pairingInFlight ? undefined : onBarcodeScanned}
            />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View
                style={{
                  width: 220,
                  height: 220,
                  borderRadius: 24,
                  borderCurve: "continuous",
                  borderWidth: 2,
                  borderColor: alpha(theme.text, theme.isDark ? 0.72 : 0.42),
                  backgroundColor: alpha(theme.text, theme.isDark ? 0.12 : 0.08),
                }}
              />
            </View>
          </View>
        )}
      </GroupedSection>

      {pairingInFlight ? (
        <GroupedSection footer="Keep Cowork Desktop open while pairing finishes.">
          <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 15 }}>
              Connecting to your Mac…
            </Text>
          </View>
        </GroupedSection>
      ) : null}

      {__DEV__ ? (
        <GroupedSection
          title="Debug"
          footer="Paste a pairing payload when the simulator camera is unavailable."
        >
          <View style={{ padding: 12, gap: 10 }}>
            <TextInput
              value={manualPayload}
              onChangeText={setManualPayload}
              placeholder="Paste cowork-pair:// payload"
              placeholderTextColor={theme.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={{
                minHeight: 88,
                borderRadius: 10,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
                color: theme.text,
                paddingHorizontal: 12,
                paddingVertical: 10,
                fontSize: 12,
                lineHeight: 18,
                fontVariant: ["tabular-nums"],
                fontFamily: theme.fontFamilyMono,
              }}
            />
            <AppButton
              fullWidth
              variant="glass"
              disabled={!manualPayload.trim() || pairingInFlight}
              icon="qrcode.viewfinder"
              onPress={() => {
                void pairManualPayload();
              }}
            >
              Pair pasted payload
            </AppButton>
            <Text
              selectable
              style={{
                color: scannedPayload ? theme.text : theme.textTertiary,
                fontSize: 12,
                lineHeight: 18,
                fontVariant: ["tabular-nums"],
                fontFamily: theme.fontFamilyMono,
              }}
            >
              {scannedPayload ?? "No QR scanned yet."}
            </Text>
          </View>
        </GroupedSection>
      ) : null}
    </GroupedScreen>
  );
}
